import FluidAudio
import Foundation

// bark-sidecar: runs a Parakeet-family Core ML model (Bark 3.0 by default)
// through FluidAudio for the Rhema desktop app.
//
//   bark-sidecar --model-dir <path> [--model-version ultra|v3] [--leading-silence <sec>]
//   bark-sidecar --model-dir <path> --file <wav> [--model-version ...] [--leading-silence <sec>]
//
// Server mode reads binary frames on stdin and writes JSON lines on stdout
// (see Protocol.swift). One-shot mode transcribes a file and prints a short
// benchmark report. Everything diagnostic goes to stderr.

// MARK: - Argument parsing

struct Options {
    var modelDir: URL
    var version: AsrModelVersion
    var leadingSilence: Double
    var file: URL?
}

enum UsageError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        if case .message(let text) = self { return text }
        return "invalid arguments"
    }
}

enum CLI {
    static let usage = """
        usage: bark-sidecar --model-dir <path> [--model-version <name>] [--leading-silence <sec>] [--file <audio>]

          --model-dir <path>        directory holding Encoder.mlmodelc, Decoder.mlmodelc,
                                    JointDecisionv3.mlmodelc, Preprocessor.mlmodelc, parakeet_vocab.json
          --model-version <name>    FluidAudio AsrModelVersion: ultra (default, also used for Bark), v3, v2, redux, phonon2
          --leading-silence <sec>   seconds of silence prepended before inference (default 0);
                                    returned timestamps have the offset removed
          --file <audio>            one-shot mode: transcribe this file and print a benchmark report
          --help                    show this message
        """
}

func parseModelVersion(_ raw: String) throws -> AsrModelVersion {
    switch raw.lowercased() {
    case "ultra", "bark", "bark3": return .ultra
    case "v3": return .v3
    case "v2": return .v2
    case "redux": return .redux
    case "phonon2": return .phonon2
    default:
        throw UsageError.message("unknown --model-version '\(raw)' (expected ultra, v3, v2, redux or phonon2)")
    }
}

func parseOptions(_ arguments: [String]) throws -> Options {
    var modelDir: String?
    var version: AsrModelVersion = .ultra
    var leadingSilence = 0.0
    var file: String?

    var index = 0
    func takeValue(for flag: String) throws -> String {
        index += 1
        guard index < arguments.count else {
            throw UsageError.message("\(flag) needs a value")
        }
        return arguments[index]
    }

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--model-dir":
            modelDir = try takeValue(for: argument)
        case "--model-version":
            version = try parseModelVersion(takeValue(for: argument))
        case "--leading-silence":
            let raw = try takeValue(for: argument)
            guard let value = Double(raw), value >= 0, value.isFinite else {
                throw UsageError.message("--leading-silence must be a non-negative number, got '\(raw)'")
            }
            leadingSilence = value
        case "--file":
            file = try takeValue(for: argument)
        case "--help", "-h":
            throw UsageError.message(CLI.usage)
        default:
            throw UsageError.message("unknown argument '\(argument)'\n\(CLI.usage)")
        }
        index += 1
    }

    guard let modelDir else {
        throw UsageError.message("--model-dir is required\n\(CLI.usage)")
    }
    return Options(
        modelDir: URL(fileURLWithPath: modelDir, isDirectory: true),
        version: version,
        leadingSilence: leadingSilence,
        file: file.map { URL(fileURLWithPath: $0) }
    )
}

// MARK: - Modes

/// Server mode: load once, emit `ready`, then answer frames until shutdown.
func runServer(options: Options) async -> Int32 {
    let writer = MessageWriter()

    let loadStart = Date()
    let transcriber: Transcriber
    do {
        transcriber = try await Transcriber.load(
            modelDir: options.modelDir,
            version: options.version,
            leadingSilenceSeconds: options.leadingSilence
        )
    } catch {
        let message = "failed to load model from \(options.modelDir.path): \(error)"
        logLine(message)
        writer.send(.error(id: 0, message: message))
        return 1
    }
    let loadMs = Int(Date().timeIntervalSince(loadStart) * 1000)
    logLine("model loaded in \(loadMs) ms")
    writer.send(.ready(loadMs: loadMs))

    let reader = FrameReader()
    while true {
        let frame: AudioFrame?
        do {
            frame = try reader.readFrame()
        } catch {
            logLine("stdin error: \(error)")
            return 1
        }
        guard let frame else {
            logLine("stdin closed, shutting down")
            return 0
        }
        if frame.isShutdown {
            logLine("shutdown frame received")
            return 0
        }

        let started = Date()
        do {
            let result = try await transcriber.transcribe(frame.samples)
            let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
            let audioSeconds = Double(frame.samples.count) / Double(Transcriber.sampleRate)
            logLine(String(format: "segment %u: %.1fs audio in %d ms", frame.id, audioSeconds, elapsedMs))
            writer.send(.result(id: frame.id, result: result, elapsedMs: elapsedMs))
        } catch {
            let message = "transcription failed: \(error)"
            logLine("segment \(frame.id): \(message)")
            writer.send(.error(id: frame.id, message: message))
        }
    }
}

/// One-shot mode: transcribe a file and print a benchmark summary to stdout.
func runFile(options: Options, file: URL) async -> Int32 {
    let samples: [Float]
    do {
        samples = try loadAudioFile(file)
    } catch {
        logLine("could not read \(file.path): \(error)")
        return 1
    }
    let audioSeconds = Double(samples.count) / Double(Transcriber.sampleRate)
    logLine(String(format: "loaded %@ (%.2f s at %d Hz mono)", file.lastPathComponent, audioSeconds, Transcriber.sampleRate))

    let loadStart = Date()
    let transcriber: Transcriber
    do {
        transcriber = try await Transcriber.load(
            modelDir: options.modelDir,
            version: options.version,
            leadingSilenceSeconds: options.leadingSilence
        )
    } catch {
        logLine("failed to load model from \(options.modelDir.path): \(error)")
        return 1
    }
    logLine(String(format: "model loaded in %.2f s", Date().timeIntervalSince(loadStart)))

    let inferenceStart = Date()
    let result: SegmentResult
    do {
        result = try await transcriber.transcribe(samples)
    } catch {
        logLine("transcription failed: \(error)")
        return 1
    }
    let inferenceSeconds = Date().timeIntervalSince(inferenceStart)
    let rtfx = inferenceSeconds > 0 ? audioSeconds / inferenceSeconds : 0
    let wordCount = result.words?.count
        ?? result.text.split(whereSeparator: { $0.isWhitespace }).count

    let report = """
        Transcript:
        \(result.text)

        Words:          \(wordCount)
        Audio duration: \(String(format: "%.2f", audioSeconds)) s
        Inference time: \(String(format: "%.3f", inferenceSeconds)) s
        RTFx:           \(String(format: "%.1f", rtfx))
        Confidence:     \(String(format: "%.3f", result.confidence))

        """
    FileHandle.standardOutput.write(Data(report.utf8))
    return 0
}

// MARK: - Entry point

func parseOptionsOrExit() -> Options {
    do {
        return try parseOptions(Array(ProcessInfo.processInfo.arguments.dropFirst()))
    } catch {
        logLine("\(error)")
        exit(2)
    }
}

let options = parseOptionsOrExit()

// Bark's compressed encoder uses Core ML ops that only exist from macOS 15.
// FluidAudio does not check this for the `.ultra` version enum, so do it here.
let minimumOS = OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)
if !ProcessInfo.processInfo.isOperatingSystemAtLeast(minimumOS) {
    let message = "Bark requires macOS 15 or later"
    logLine(message)
    MessageWriter().send(.error(id: 0, message: message))
    exit(1)
}

var isDirectory: ObjCBool = false
if !FileManager.default.fileExists(atPath: options.modelDir.path, isDirectory: &isDirectory) || !isDirectory.boolValue {
    let message = "model directory not found: \(options.modelDir.path)"
    logLine(message)
    MessageWriter().send(.error(id: 0, message: message))
    exit(1)
}

logLine("model dir: \(options.modelDir.path), version: \(options.version), leading silence: \(options.leadingSilence)s")

let status: Int32
if let file = options.file {
    status = await runFile(options: options, file: file)
} else {
    status = await runServer(options: options)
}
exit(status)
