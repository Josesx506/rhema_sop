import Foundation

// MARK: - Logging

/// Writes one line to stderr. stdout is reserved for protocol JSON lines, so
/// every diagnostic goes through here.
func logLine(_ message: String) {
    let data = Data(("[bark-sidecar] " + message + "\n").utf8)
    FileHandle.standardError.write(data)
}

// MARK: - stdin frames

/// One audio segment received from the host.
///
/// Wire format (little-endian, repeated until EOF):
///
///     u32  segment_id
///     u32  n_samples
///     f32  samples[n_samples]   // 16 kHz mono, range [-1, 1]
///
/// A frame with `n_samples == 0` is the shutdown request.
struct AudioFrame: Sendable {
    let id: UInt32
    let samples: [Float]

    var isShutdown: Bool { samples.isEmpty }
}

enum FrameReadError: Error, CustomStringConvertible {
    case truncated(expected: Int, got: Int)

    var description: String {
        switch self {
        case .truncated(let expected, let got):
            return "stdin closed mid-frame: expected \(expected) bytes, got \(got)"
        }
    }
}

/// Reads binary frames from standard input, pulling exactly the bytes each
/// frame needs. `FileHandle.readData(ofLength:)` on a pipe may return fewer
/// bytes than requested, so every read loops until the count is satisfied or
/// the stream ends.
final class FrameReader {
    private let input = FileHandle.standardInput

    /// Returns the next frame, or `nil` on a clean EOF at a frame boundary.
    /// Throws if the stream ends part way through a frame.
    func readFrame() throws -> AudioFrame? {
        guard let header = try readExactly(8, allowEOFAtStart: true) else {
            return nil
        }
        let id = header.loadLittleEndianUInt32(at: 0)
        let count = Int(header.loadLittleEndianUInt32(at: 4))
        if count == 0 {
            return AudioFrame(id: id, samples: [])
        }
        guard let payload = try readExactly(count * 4, allowEOFAtStart: false) else {
            // readExactly only returns nil when allowEOFAtStart is true.
            throw FrameReadError.truncated(expected: count * 4, got: 0)
        }
        return AudioFrame(id: id, samples: payload.decodeLittleEndianFloats(count: count))
    }

    /// Reads exactly `length` bytes. Returns `nil` only when `allowEOFAtStart`
    /// is set and no bytes at all were available (clean EOF).
    private func readExactly(_ length: Int, allowEOFAtStart: Bool) throws -> Data? {
        var buffer = Data()
        buffer.reserveCapacity(length)
        while buffer.count < length {
            let chunk = input.readData(ofLength: length - buffer.count)
            if chunk.isEmpty {
                if buffer.isEmpty && allowEOFAtStart {
                    return nil
                }
                throw FrameReadError.truncated(expected: length, got: buffer.count)
            }
            buffer.append(chunk)
        }
        return buffer
    }
}

extension Data {
    /// Reads a little-endian `UInt32` at `offset` without assuming alignment.
    func loadLittleEndianUInt32(at offset: Int) -> UInt32 {
        let raw = withUnsafeBytes { bytes -> UInt32 in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
        }
        return UInt32(littleEndian: raw)
    }

    /// Interprets the buffer as `count` little-endian IEEE 754 floats.
    func decodeLittleEndianFloats(count: Int) -> [Float] {
        var bits = [UInt32](repeating: 0, count: count)
        bits.withUnsafeMutableBufferPointer { destination in
            _ = copyBytes(to: destination)
        }
        return bits.map { Float(bitPattern: UInt32(littleEndian: $0)) }
    }
}

// MARK: - stdout messages

/// A word with timing, after FluidAudio's subword tokens have been grouped.
/// The protocol calls the array `tokens` for historical reasons; the entries
/// are word-level.
struct WordToken: Encodable, Sendable {
    let text: String
    let start: Double
    let end: Double
    let confidence: Float
}

/// Everything the host needs for one segment.
struct SegmentResult: Sendable {
    let text: String
    let confidence: Float
    /// `nil` when FluidAudio returned no token timings; the field is then
    /// omitted from the JSON line so the host falls back to even spacing.
    let words: [WordToken]?

    static let empty = SegmentResult(text: "", confidence: 0, words: nil)
}

/// One JSON line on stdout. `Encodable` conformance drives the exact field
/// names the Rust side parses, so keep these in sync with the spec.
enum OutgoingMessage: Encodable {
    case ready(loadMs: Int)
    case result(id: UInt32, result: SegmentResult, elapsedMs: Int)
    case error(id: UInt32, message: String)

    private enum CodingKeys: String, CodingKey {
        case type, id, message
        case loadMs = "load_ms"
        case text, confidence, tokens
        case elapsedMs = "elapsed_ms"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ready(let loadMs):
            try container.encode("ready", forKey: .type)
            try container.encode(loadMs, forKey: .loadMs)
        case .result(let id, let result, let elapsedMs):
            try container.encode("result", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(result.text, forKey: .text)
            try container.encode(result.confidence, forKey: .confidence)
            try container.encode(elapsedMs, forKey: .elapsedMs)
            // encodeIfPresent omits the key entirely when words is nil.
            try container.encodeIfPresent(result.words, forKey: .tokens)
        case .error(let id, let message):
            try container.encode("error", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(message, forKey: .message)
        }
    }
}

/// Serialises protocol messages as single JSON lines on stdout.
///
/// `FileHandle.standardOutput.write` issues the write syscall directly, with
/// no user-space buffering, so each line reaches the pipe before `send`
/// returns. Never mix this with `print`, which buffers through libc stdio.
final class MessageWriter {
    private let output = FileHandle.standardOutput
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    func send(_ message: OutgoingMessage) {
        do {
            var data = try encoder.encode(message)
            data.append(0x0A)
            output.write(data)
        } catch {
            // JSONEncoder only fails on non-finite floats; sanitise and retry
            // so the host never waits on a line that was never written.
            logLine("failed to encode message: \(error)")
            if case .result(let id, _, _) = message {
                send(.error(id: id, message: "failed to encode result: \(error)"))
            }
        }
    }
}
