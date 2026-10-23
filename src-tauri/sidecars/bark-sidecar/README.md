# bark-sidecar

Swift executable that runs a Parakeet-family Core ML speech model (Underdog Bark 3.0 by default) through [FluidAudio](https://github.com/FluidInference/FluidAudio) v0.17.7. The Rust `BarkProvider` in `src-tauri/crates/stt` spawns it once per transcription session and talks to it over stdin/stdout.

## Requirements

- Build: macOS 14 or later with a Swift 6 toolchain (Xcode 16+ or a swift.org 6.x toolchain). FluidAudio is a `swift-tools-version: 6.0` package, so the Swift 5.10 toolchain that ships with the macOS 14 Command Line Tools cannot build it.
- Run: macOS 15 or later on Apple Silicon. Bark's compressed encoder uses Core ML ops that only exist from macOS 15; the sidecar checks this at startup and emits a protocol error on older systems.
- Model: the `bark-3.0/` folder from `FluidInference/bark-3.0-coreml` (`bun run download:bark` places it at `models/bark/bark-3.0`). It must contain `Encoder.mlmodelc`, `Decoder.mlmodelc`, `JointDecisionv3.mlmodelc`, `Preprocessor.mlmodelc` and `parakeet_vocab.json`. `Encoder_lut3.mlmodelc` is a GPU-only variant that `loadLocal` never reads and is not needed.

## Build

From the repository root:

```sh
bun run build:bark-sidecar
# or directly
scripts/build-bark-sidecar.sh
```

The script runs `swift build -c release --arch arm64` in this directory and copies the binary to `src-tauri/binaries/bark-sidecar-aarch64-apple-darwin`, which is the name Tauri's `externalBin` expects. `src-tauri/binaries/` is git-ignored.

The first `swift build` resolves and compiles FluidAudio (several minutes). Later builds are incremental.

## Usage

Server mode (what the app uses):

```sh
bark-sidecar --model-dir models/bark/bark-3.0 [--model-version ultra] [--leading-silence 0]
```

One-shot benchmark mode:

```sh
bark-sidecar --model-dir models/bark/bark-3.0 --file sermon.wav
```

Any file AVFoundation can read is accepted and resampled to 16 kHz mono. The report (transcript, word count, audio duration, inference time, RTFx, confidence) goes to stdout; progress goes to stderr.

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model-dir <path>` | required | Folder with the `.mlmodelc` bundles and vocabulary |
| `--model-version <name>` | `ultra` | FluidAudio `AsrModelVersion`: `ultra` (Bark and Parakeet Ultra share this layout), `v3`, `v2`, `redux`, `phonon2` |
| `--leading-silence <sec>` | `0` | Seconds of zeros prepended before inference. Returned timestamps have this offset subtracted, so callers never see the padding |
| `--file <audio>` | none | One-shot mode instead of server mode |

To benchmark Parakeet Ultra instead of Bark, download `FluidInference/parakeet-ultra-coreml` into another folder and pass it as `--model-dir`; the version enum stays `ultra`.

## Protocol (server mode)

stdin, binary, little-endian, repeated:

```
u32  segment_id
u32  n_samples
f32  samples[n_samples]   // 16 kHz mono, range [-1, 1]
```

A frame with `n_samples == 0`, or EOF on stdin, shuts the sidecar down cleanly (exit 0). The reader pulls exactly the bytes each frame needs; a stream that ends mid-frame is logged and exits 1.

stdout, one JSON object per line, written unbuffered after every message:

```json
{"type":"ready","load_ms":1234}
{"type":"result","id":7,"text":"...","confidence":0.96,"elapsed_ms":85,"tokens":[{"text":"John","start":0.31,"end":0.52,"confidence":0.97}]}
{"type":"error","id":7,"message":"..."}
```

- `ready` is sent only after the models are loaded. The first launch compiles the encoder for the Neural Engine, which can take minutes; a stderr line is logged every 15 s meanwhile.
- `tokens` are word-level (FluidAudio's `buildWordTimings` groups the SentencePiece subwords). Each word's `confidence` is the mean of its member tokens' confidences. The key is omitted when FluidAudio returned no token timings.
- `<unk>` tokens (Bark emits them where its training text had quotation marks) are stripped from `text` and from `tokens`, and any double spaces left behind are collapsed.
- Segments shorter than FluidAudio's minimum (0.3 s, 4800 samples, after leading-silence padding) return an empty `result` rather than an error.
- Fatal startup problems (unsupported macOS, missing model directory, model load failure) are reported as `{"type":"error","id":0,...}` followed by a non-zero exit.
- Every segment is decoded with a fresh `TdtDecoderState`, so segments are independent.

## Logging

All diagnostics go to stderr with a `[bark-sidecar]` prefix. stdout carries only protocol lines (server mode) or the benchmark report (one-shot mode).

## FluidAudio API notes (v0.17.7)

Verified against the tagged sources:

- `AsrModels.loadLocal(from:version:configuration:encoderPrecision:encoderComputeUnits:) throws -> AsrModels` is synchronous. `version` defaults to `.v3`, so the sidecar passes it explicitly.
- `AsrModelVersion` cases: `v2`, `v3`, `redux`, `ultra`, `phonon2`, `tdtCtc110m`, `tdtJa`. Bark loads through `.ultra`.
- `AsrManager` is an actor: `init(config: ASRConfig = .default, models: AsrModels? = nil)`, `loadModels(_:) async throws`, `decoderLayerCount: Int`, `transcribe(_ samples: [Float], decoderState: inout TdtDecoderState, language: Language? = nil) async throws -> ASRResult`.
- `TdtDecoderState.make(decoderLayers:)` is the non-throwing factory.
- `ASRResult` has `text`, `confidence`, `duration`, `processingTime`, `tokenTimings: [TokenTiming]?`. `TokenTiming` has `token`, `tokenId`, `startTime`, `endTime`, `confidence`.
- `buildWordTimings(from:) -> [WordTiming]` and `isWordBoundary(_:)` are public free functions. `WordTiming` has no confidence field, which is why the sidecar computes it.
- `ASRConstants.minimumRequiredSamples(forSampleRate:)` gives the short-segment threshold (0.3 s).
- The package product and target are both named `FluidAudio`.
