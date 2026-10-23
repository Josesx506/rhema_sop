import FluidAudio
import Foundation

/// Thin wrapper over FluidAudio's `AsrManager` for the Parakeet TDT family
/// (Bark 3.0, Parakeet Ultra, Parakeet v3). One instance owns one loaded
/// model and transcribes independent segments.
final class Transcriber: Sendable {
    /// FluidAudio's expected input rate.
    static let sampleRate = ASRConstants.sampleRate

    /// Segments shorter than this would make FluidAudio throw
    /// `ASRError.invalidAudioData`; we return an empty result instead.
    static let minimumSamples = ASRConstants.minimumRequiredSamples(forSampleRate: sampleRate)

    private let manager: AsrManager
    private let decoderLayers: Int
    private let leadingSilenceSamples: Int
    private let leadingSilenceSeconds: Double

    private init(manager: AsrManager, decoderLayers: Int, leadingSilenceSeconds: Double) {
        self.manager = manager
        self.decoderLayers = decoderLayers
        self.leadingSilenceSeconds = leadingSilenceSeconds
        self.leadingSilenceSamples = Int((leadingSilenceSeconds * Double(Self.sampleRate)).rounded())
    }

    /// Loads the Core ML models from `modelDir` and prepares an `AsrManager`.
    ///
    /// `AsrModels.loadLocal` is synchronous and can block for minutes on the
    /// first launch while Core ML compiles the encoder for the Neural Engine,
    /// so a detached task logs progress every 15 s until it returns. The
    /// default compute units (CPU + ANE) are kept on purpose: `.cpuAndGPU`
    /// rebuilds the sparse encoder on every load.
    static func load(
        modelDir: URL,
        version: AsrModelVersion,
        leadingSilenceSeconds: Double
    ) async throws -> Transcriber {
        let started = Date()
        let ticker = Task.detached {
            while !Task.isCancelled {
                try await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                let elapsed = Int(Date().timeIntervalSince(started))
                logLine("still loading model (\(elapsed)s elapsed); first launch compiles the encoder for the Neural Engine")
            }
        }
        defer { ticker.cancel() }

        let models = try AsrModels.loadLocal(from: modelDir, version: version)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        let layers = await manager.decoderLayerCount
        return Transcriber(manager: manager, decoderLayers: layers, leadingSilenceSeconds: leadingSilenceSeconds)
    }

    /// Transcribes one segment of 16 kHz mono samples. Each call uses a fresh
    /// `TdtDecoderState`, which is what makes segments independent;
    /// `AsrManager.reset()` does not reset decoder state.
    func transcribe(_ samples: [Float]) async throws -> SegmentResult {
        let padded: [Float]
        if leadingSilenceSamples > 0 {
            padded = [Float](repeating: 0, count: leadingSilenceSamples) + samples
        } else {
            padded = samples
        }
        guard padded.count >= Self.minimumSamples else {
            return .empty
        }

        var state = TdtDecoderState.make(decoderLayers: decoderLayers)
        let result = try await manager.transcribe(padded, decoderState: &state)
        return Self.postProcess(result, offsetSeconds: leadingSilenceSeconds)
    }

    // MARK: - Post-processing

    /// Bark emits `<unk>` (token id 0) wherever its training text had a
    /// quotation mark. Strip it from the text and from the token list, then
    /// group the remaining subwords into words with per-word confidence.
    static func postProcess(_ result: ASRResult, offsetSeconds: Double) -> SegmentResult {
        let text = stripUnknownTokens(from: result.text)
        guard let timings = result.tokenTimings else {
            return SegmentResult(text: text, confidence: result.confidence, words: nil)
        }
        let kept = timings.filter { !isUnknownToken($0.token) }
        let words = groupWords(kept, fallbackConfidence: result.confidence, offsetSeconds: offsetSeconds)
        return SegmentResult(text: text, confidence: result.confidence, words: words)
    }

    static let unknownToken = "<unk>"

    /// True for `<unk>` with or without the SentencePiece word-boundary prefix.
    static func isUnknownToken(_ token: String) -> Bool {
        stripWordBoundaryPrefix(token) == unknownToken
    }

    /// Removes every `<unk>` from `text` and collapses the double spaces that
    /// stripping leaves behind.
    static func stripUnknownTokens(from text: String) -> String {
        guard text.contains(unknownToken) else { return text }
        var cleaned = text.replacingOccurrences(of: unknownToken, with: "")
        while cleaned.contains("  ") {
            cleaned = cleaned.replacingOccurrences(of: "  ", with: " ")
        }
        // Stripping can also leave a space before punctuation, as in `said ,`.
        for mark in [",", ".", "?", "!", ";", ":"] {
            cleaned = cleaned.replacingOccurrences(of: " " + mark, with: mark)
        }
        return cleaned.trimmingCharacters(in: .whitespaces)
    }

    /// Groups subword tokens into words with FluidAudio's `buildWordTimings`
    /// and averages the member tokens' confidences for each word.
    ///
    /// `buildWordTimings` does not report which tokens made up each word, so
    /// the membership is recomputed here with the same boundary rule
    /// (`isWordBoundary`, which FluidAudio also exports) and the same skip
    /// list. If the two walks disagree on the word count, the segment's
    /// overall confidence is used for every word rather than misaligning.
    static func groupWords(
        _ tokens: [TokenTiming],
        fallbackConfidence: Float,
        offsetSeconds: Double
    ) -> [WordToken] {
        let words = buildWordTimings(from: tokens)
        if words.isEmpty { return [] }

        var groups: [[Float]] = []
        var inWord = false
        for timing in tokens {
            let token = timing.token
            if token.isEmpty || token == "<blank>" || token == "<pad>" {
                continue
            }
            if isWordBoundary(token) || !inWord {
                groups.append([timing.confidence])
                inWord = true
            } else {
                groups[groups.count - 1].append(timing.confidence)
            }
        }

        let aligned = groups.count == words.count
        return words.enumerated().map { index, word in
            let confidence: Float
            if aligned {
                let members = groups[index]
                confidence = members.reduce(0, +) / Float(members.count)
            } else {
                confidence = fallbackConfidence
            }
            return WordToken(
                text: word.word,
                start: max(0, word.startTime - offsetSeconds),
                end: max(0, word.endTime - offsetSeconds),
                confidence: confidence
            )
        }
    }
}

// MARK: - One-shot file input

/// Decodes an audio file (WAV or anything AVFoundation reads) and resamples
/// it to 16 kHz mono Float32. FluidAudio's `AudioConverter` wraps
/// `AVAudioConverter` with the model's default target format and drains the
/// resampler correctly, so it is reused rather than reimplemented.
func loadAudioFile(_ url: URL) throws -> [Float] {
    try AudioConverter().resampleAudioFile(url)
}
