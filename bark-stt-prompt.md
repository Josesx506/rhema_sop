# Task: Add Underdog Bark 3.0 as a local STT provider (macOS only)

You are working in my private fork of Rhema (`Josesx506/rhema_sop`, forked from `openbezal/rhema`), a Tauri + Rust + React app that transcribes a live sermon and detects Bible verse references. Create a branch `feat/bark-stt` and implement the work below. Do not push or open a PR until I review.

## Context

- I run local models on a Mac (Apple Silicon) and use Deepgram on Windows. Windows behavior must not change.
- The app currently offers two STT providers: `deepgram` (cloud) and `whisper` (local, whisper-rs; the model file is user-selectable in Settings, default `ggml-large-v3-turbo-q8_0.bin`).
- I want a third provider, `bark`, using **Underdog Bark 3.0** by Conway Research: a 0.6B English-only ASR model fine-tuned from NVIDIA Parakeet TDT 0.6B v3 (via Moondream's parakeet-ultra). Conway's self-reported 7-dataset average is 4.94% WER versus 6.58% for Whisper large-v3-turbo. Bark is not on the official Open ASR Leaderboard, and on FluidInference's own Core ML LibriSpeech run it scores slightly worse than the plain Parakeet v3 and Parakeet Ultra builds. So the accuracy win over Whisper is plausible but unproven for sermons; the speed win is near-certain (roughly 140x real time on the Neural Engine). The primary goal of this work is to let me measure both on recorded sermons.
- Use the Core ML build: Hugging Face repo `FluidInference/bark-3.0-coreml`, folder `bark-3.0/` (the verbatim model; the sibling `bark-3.0-clean/` drops fillers and repeated words and must not be used, because it can delete an intentionally repeated verse number). License CC-BY-4.0; the folder's `NOTICE` file has the attribution chain.
- Run it through **FluidAudio** (Swift package, `https://github.com/FluidInference/FluidAudio`, Apache-2.0). Pin release **v0.17.7**. Rust cannot call it directly, so use a Swift sidecar process. Native Bark support (`.bark3` version enum, automatic `<unk>` stripping, platform check) is in the unmerged FluidAudio PR #1054; do not depend on it. Today Bark loads through the `.ultra` version enum, which shares Bark's model layout.
- Make the sidecar model-agnostic (model directory and version enum are CLI arguments) so I can also benchmark `FluidInference/parakeet-ultra-coreml` by pointing at a different folder. Only Bark is exposed in the UI in this task.
- Keep the Whisper provider fully working as a fallback.

Before writing code, read these files so your changes match existing patterns:

- `src-tauri/crates/stt/src/provider.rs` (the `SttProvider` trait: async `start(audio_rx: crossbeam Receiver<Vec<i16>>, event_tx: tokio mpsc Sender<TranscriptEvent>)`, sync `stop()`, `name()`)
- `src-tauri/crates/stt/src/whisper.rs` (the VAD buffering and flush loop, lines ~140-221, and the inference loop and event emission)
- `src-tauri/crates/audio/src/vad.rs` (`Vad`, `VadConfig`, `VadTransition::{SpeechStarted, SpeechEnded}`; this is already a shared module)
- `src-tauri/crates/stt/src/types.rs`, `error.rs`, `lib.rs`, `Cargo.toml`
- `src-tauri/src/commands/stt.rs` (provider selection `match` on the provider string; `[STT-{name}]` logging)
- `src-tauri/src/commands/whisper_model.rs` (`resolve_whisper_model`: dev tree, then app-data, then bundled resources; plus the in-app download, cancel, status and delete commands)
- `src-tauri/src/commands/mod.rs` and `src-tauri/src/lib.rs` (command registration in `generate_handler!`)
- `src-tauri/Cargo.toml` (features, workspace lints with `pedantic = warn`), `src-tauri/tauri.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/entitlements.plist`
- `src/stores/settings-store.ts`, `src/stores/settings-store.test.ts`, `src/components/settings-dialog.tsx`, `src/components/settings/whisper-model-section.tsx`, `src/hooks/use-transcription.ts`, `src/hooks/use-transcription.test.ts`
- `data/download-whisper-model.ts`, `package.json` scripts, `README.md`, `CHANGELOG.md`

If my fork has diverged from what this document describes, follow the code as it exists and tell me what differed.

## Architecture

```
mic -> rhema-audio -> commands/stt.rs -> BarkProvider (Rust)
                                          |  VAD segments speech (same loop as Whisper)
                                          |  stdin: binary audio frames
                                          v
                                     bark-sidecar (Swift, FluidAudio, Core ML / ANE)
                                          |  stdout: JSON lines
                                          v
                                    TranscriptEvent::Final -> detection pipeline
```

The sidecar is spawned once when transcription starts and loads the model once. It stays alive until transcription stops.

## Part 1: Swift sidecar (`src-tauri/sidecars/bark-sidecar/`)

Create a Swift Package executable target named `bark-sidecar` that depends on FluidAudio v0.17.7 (exact version). Swift tools 6.0. Package platform `macOS(.v14)` (FluidAudio's minimum); the Bark model itself needs macOS 15, see the runtime check below.

Model loading (verified against v0.17.7; `loadLocal` is synchronous, `loadModels` is async):

```swift
import FluidAudio
let models = try AsrModels.loadLocal(from: modelDir, version: version)   // version defaults to .ultra
let asr = AsrManager(config: .default)
try await asr.loadModels(models)
```

Per segment, create a fresh decoder state and call the in-memory API:

```swift
var state = TdtDecoderState.make(decoderLayers: asr.decoderLayerCount)
let result = try await asr.transcribe(samples, decoderState: &state)   // samples: [Float], 16 kHz mono
```

`AsrManager.reset()` does not reset decoder state, so recreating `TdtDecoderState` per segment is required for segments to be independent. Do not pass a `MLModelConfiguration` with `.cpuAndGPU`: the sparse `Encoder.mlmodelc` is rebuilt on every GPU load and takes minutes. Keep the default compute units (CPU + ANE).

`ASRResult` gives `text`, `confidence`, and `tokenTimings: [TokenTiming]?` with per-token `token`, `startTime`, `endTime`, `confidence`. Use FluidAudio's public `buildWordTimings(from:)` to group SentencePiece subwords into words, and average the member tokens' confidences for a per-word confidence. If `tokenTimings` is nil, omit `tokens` from the result line.

Bark emits `<unk>` (token id 0) wherever its training text had a quotation mark, which a sermon quoting scripture triggers constantly. Strip `<unk>` from `text` and from the token list before building words. Collapse any double spaces that stripping leaves behind.

Audio shorter than FluidAudio's minimum sample count throws `ASRError.invalidAudioData`. Guard it: return an empty result for segments below the minimum instead of an error.

Runtime platform check: at startup, if `ProcessInfo.processInfo.isOperatingSystemAtLeast(15.0.0)` is false, emit `{"type":"error","id":0,"message":"Bark requires macOS 15 or later"}` and exit non-zero.

### CLI

- `bark-sidecar --model-dir <path> [--model-version ultra|v3] [--leading-silence <sec>]`: server mode (protocol below).
- `bark-sidecar --model-dir <path> --file <wav> [--model-version ...] [--leading-silence <sec>]`: one-shot mode. Transcribe a WAV (any sample rate; resample to 16 kHz mono with AVAudioConverter) and print the text, word count, audio duration, inference time, and RTFx to stdout. I will use this to benchmark Bark against Parakeet Ultra and Whisper on recorded sermons.
- `--leading-silence` defaults to 0. Conway evaluates Bark with 0.25 s of leading silence, but FluidInference measured no difference through FluidAudio's pipeline and adds none. When non-zero, the sidecar prepends that many seconds of zeros before inference and subtracts the offset from all returned timestamps, so the Rust side never sees the padding.

### Protocol (server mode)

stdin, binary, little-endian, repeated:

```
u32  segment_id
u32  n_samples
f32  samples[n_samples]   // 16 kHz mono, range [-1, 1]
```

A frame with `n_samples == 0` means shut down cleanly. EOF on stdin also means shut down.

stdout, one JSON object per line, flushed after every line:

```json
{"type":"ready","load_ms":1234}
{"type":"result","id":7,"text":"...","confidence":0.96,"elapsed_ms":85,"tokens":[{"text":"John","start":0.31,"end":0.52,"confidence":0.97}]}
{"type":"error","id":7,"message":"..."}
```

- `tokens` are word-level (after `buildWordTimings`), not subword-level, despite the field name.
- Emit `ready` only after models are loaded. The first launch compiles the encoder for the Neural Engine. FluidInference says up to a minute; Conway says several minutes. Log a stderr line every 15 s while loading so the user sees progress.
- All logging goes to stderr, never stdout.

### Build

- Add `scripts/build-bark-sidecar.sh` that runs `swift build -c release --arch arm64` and copies the binary to `src-tauri/binaries/bark-sidecar-aarch64-apple-darwin` (Tauri `externalBin` naming requires the target triple suffix). The `scripts/` directory exists and currently holds only `setup-windows.ps1`.
- Add a `build:bark-sidecar` script to `package.json`.
- Add `src-tauri/binaries/` to `.gitignore`.

## Part 2: Rust provider (`src-tauri/crates/stt/src/bark.rs`)

- Add a `bark` feature to `rhema-stt`. The crate's optional `rhema-audio` dep is enabled by bare name in the `whisper` feature, so write `bark = ["rhema-audio"]`. `serde_json` is already a non-optional dep and `tokio` is the workspace `full` feature set, so no new deps. Gate the module with `#[cfg(all(feature = "bark", target_os = "macos"))]` and re-export `BarkProvider` from `lib.rs` under the same cfg. Update the crate doc comment.
- Add `bark = ["rhema-stt/bark"]` to `src-tauri/Cargo.toml` and include it in default features (currently `default = ["whisper"]`). It compiles to nothing on Windows and Linux.
- Implement `SttProvider` for `BarkProvider { sidecar_path: PathBuf, model_dir: PathBuf, cancelled: Arc<AtomicBool> }`.

### Behavior

1. **VAD segmentation:** reuse the buffering and flush loop from `whisper.rs` unchanged: the inline `VadConfig` overrides (`silence_threshold: 0.01`, `frame_threshold: 0.005`, `min_voice_frames: 6`), `MIN_BUFFER_SAMPLES = 16_000`, `MAX_BUFFER_SAMPLES = 160_000`, drop segments under 1 s, flush on `SpeechEnded`, on `MAX_BUFFER`, on cancel, and on channel disconnect, and forward `TranscriptEvent::SpeechStarted`. Prefer extracting that loop into a shared `segmenter.rs` (the VAD itself is already shared in `rhema_audio`) used by both providers, as long as Whisper behavior is byte-for-byte unchanged. If extraction gets messy, duplicate it and leave a comment.
2. **Startup:** check that both `sidecar_path` and `model_dir` exist (return `SttError::ModelNotFound` with a helpful message otherwise). Spawn the sidecar with `tokio::process::Command` (stdin/stdout piped, stderr forwarded line by line to `log::info!` with the `[BARK]` prefix). Wait for `ready` with a 300 s timeout, then send `TranscriptEvent::Connected`. On timeout or early exit, send `TranscriptEvent::Error` and return an error.
3. **Inference loop:** this provider is async over `tokio::process`, so do not copy Whisper's `spawn_blocking` inference task; only the VAD task stays blocking. Convert each segment to f32, write a frame, read the matching `result` line. Map it to `TranscriptEvent::Final { transcript, words, confidence, speech_final: true }` followed by `TranscriptEvent::UtteranceEnd`, matching what Whisper emits (Whisper skips `Final` for empty text but always sends `UtteranceEnd`). Build `Word` values from `tokens`: lowercase `text`, original in `punctuated_word`, timestamps as given (padding is already handled in the sidecar). Use the result's `confidence`; if `tokens` is absent, fall back to evenly spaced word timings across the segment like Whisper does. Skip empty transcripts.
4. **Errors:** on an `error` line, emit `TranscriptEvent::Error` and continue. If the sidecar dies mid-session, emit an error and end the provider; do not crash the app.
5. **Stop:** `stop()` sets the cancel flag. On exit, send the zero-length shutdown frame, wait up to 2 s, then kill the child. Always send `TranscriptEvent::Disconnected` at the end.
6. Add `SttError::SidecarFailed(String)`; the enum is `#[non_exhaustive]`.
7. `name()` returns `"bark"`. Log with a `[BARK]` prefix everywhere (whisper.rs mixes `[WHISPER]` and `[Whisper]`; do not copy that), including the per-segment line `Transcribed {audio_s:.1}s audio in {elapsed:?}: "{text}"`.

### Tests

`rhema-stt` currently has no tests, so these will be the first. Put unit tests in `bark.rs` (or the shared module) for:

- Frame encoding (header + little-endian samples).
- JSON line parsing for `ready`, `result` with and without `tokens`, `error`, and malformed lines.
- Token-to-`Word` mapping, including the evenly spaced fallback.
- An integration-style test that runs the provider against a fake sidecar (a tiny shell script in `tests/fixtures/` that emits `ready` and canned results), so the protocol is tested without the real model. Gate it with the same cfg as the module.

## Part 3: Wiring

### `src-tauri/src/commands/stt.rs`

Add a `"bark"` arm next to `"whisper"`, under `#[cfg(all(feature = "bark", target_os = "macos"))]`, plus a `#[cfg(not(...))]` arm that returns `"Bark is only available on macOS"` (same shape as the existing no-whisper arm).

### `src-tauri/src/commands/bark_model.rs` (new, modeled on `whisper_model.rs`)

- `resolve_bark_model(app) -> Option<(PathBuf, &'static str)>` with the same three-tier order as Whisper: `{CARGO_MANIFEST_DIR}/../models/bark/bark-3.0` (dev), `app_data_dir()/models/bark/bark-3.0` (downloaded in-app), `resource_dir()/models/bark/bark-3.0` (bundled). A directory counts as installed only if `Encoder.mlmodelc`, `Decoder.mlmodelc`, `JointDecisionv3.mlmodelc`, `Preprocessor.mlmodelc` and `parakeet_vocab.json` are all present. Error message when missing: `Bark model not found. Download it in Settings → Speech Recognition.`
- `resolve_bark_sidecar() -> Option<PathBuf>`: dev `{CARGO_MANIFEST_DIR}/binaries/bark-sidecar-aarch64-apple-darwin`; prod next to the app executable (`std::env::current_exe()` parent, where Tauri places `externalBin`, named `bark-sidecar`). Error message: `Bark sidecar not found. Run: bun run build:bark-sidecar`.
- Tauri commands `bark_model_status`, `download_bark_model`, `cancel_bark_download`, `delete_bark_model`, mirroring the Whisper ones. The download walks the HF tree `https://huggingface.co/api/models/FluidInference/bark-3.0-coreml/tree/main/bark-3.0?recursive=true` (the `.mlmodelc` entries are directories) and fetches each file from `https://huggingface.co/FluidInference/bark-3.0-coreml/resolve/main/<path>`, preserving structure, with `.tmp` + rename per file and skip-if-size-matches. **Skip `Encoder_lut3.mlmodelc` entirely**: it is a 252 MB GPU-only variant that `loadLocal` never reads. The remaining download is about 437 MB. Report progress the way the Whisper downloader does. Register the commands in `commands/mod.rs` and `lib.rs`, and gate the whole module and its registrations with the bark cfg.

### Bundling (macOS only)

The Whisper model is not bundled in releases and the Bark model should not be either (437 MB). Only the sidecar is bundled. In `src-tauri/tauri.macos.conf.json` (not the shared config), add `bundle.externalBin: ["binaries/bark-sidecar"]`. There is no existing `externalBin`; this is the first. `signingIdentity` is `"-"` (ad hoc) with `entitlements.plist`; Tauri signs external binaries with the same identity. After `bun tauri build`, verify with `codesign -dv --entitlements - <app>/Contents/MacOS/bark-sidecar` that the sidecar is signed and runs from inside the bundle. Leave `minimumSystemVersion` at `11.0`; Bark is gated at runtime by the sidecar check and the UI copy.

### Dev model download script

Add `data/download-bark-model.ts` modeled on `download-whisper-model.ts`, using the same tree walk and skip rules as the Rust downloader, writing to `models/bark/bark-3.0/`. Add `download:bark` to `package.json`. `models/*` is already in `.gitignore`.

### Frontend

- `src/stores/settings-store.ts`: extend the `SttProvider` type to `"deepgram" | "whisper" | "bark"`. Hydration copies stored values without validation, so older persisted settings keep working; add a guard that falls back to `"deepgram"` if a stored provider is not one of the three.
- `src/lib/platform.ts` (new): `export const isMacOS = navigator.userAgent.includes("Mac OS")`. There is no existing platform detection and `@tauri-apps/plugin-os` is not installed; do not add it.
- `src/components/settings-dialog.tsx`: add a "Local (Bark)" `RadioGroupItem` after "Local (Whisper)", rendered only when `isMacOS`, with the description: "English only. Runs on the Apple Neural Engine. Requires macOS 15 or later. First start can take a few minutes while the model compiles." Update the `onValueChange` cast. Add `{sttProvider === "bark" && <BarkModelSection />}` next to the Whisper section. Change the API-key hint condition from `sttProvider === "whisper"` to `sttProvider !== "deepgram"`.
- `src/components/settings/bark-model-section.tsx` (new): mirror `whisper-model-section.tsx` for a single fixed model (status, download with progress, cancel, delete).
- `src/hooks/use-transcription.ts` needs no new payload field. Add a `bark` case to `use-transcription.test.ts` asserting the invoke payload, alongside the existing deepgram and whisper cases. `settings-store.test.ts` does not enumerate providers and needs no change.

### Attribution and docs

- README has no credits section. Add a "Credits" section listing: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), Moondream parakeet-ultra (CC-BY-4.0), Conway Research Underdog Bark 3.0 (CC-BY-4.0), Fluid Inference's Core ML conversion, FluidAudio (Apache-2.0), plus the existing Whisper and Deepgram mentions.
- Add a short "Local Bark STT (macOS)" section to the README with setup steps (`bun run download:bark`, `bun run build:bark-sidecar`, select "Local (Bark)" in Settings) and the one-shot benchmark command.
- Add a CHANGELOG entry under the next version.

## Constraints

- Do not change the Deepgram or Whisper code paths' behavior. Run the frontend vitest suites and `cargo test --workspace` before and after.
- No new dependencies beyond FluidAudio (Swift). On the Rust side, everything needed is already in the workspace.
- Follow the workspace lints (`[lints] workspace = true`, clippy pedantic); `cargo clippy --all-features` must be clean. Use `#[expect(..., reason = "...")]` for any lint you must silence, which is the house style.
- No em dashes in new docs, comments, or UI copy (the existing codebase has them; do not go and remove those).

## Done when

1. `cargo test -p rhema-stt --features bark`, `cargo test --workspace`, and the frontend test suites pass.
2. `cargo clippy --all-features` is clean, and the app still builds with default features on a non-macOS target (verify with `cargo check --target x86_64-pc-windows-msvc` if the toolchain is available; otherwise explain how you reasoned about cfg gating).
3. `bun run download:bark && bun run build:bark-sidecar` succeed on my Mac.
4. `bark-sidecar --model-dir models/bark/bark-3.0 --file <sample.wav>` prints a sensible transcript with timing and RTFx.
5. `bun tauri dev`, select "Local (Bark)", speak these three phrasings and report what the transcript literally contains for each, since Parakeet-family models are undocumented on digit-versus-word output: "Turn with me to John chapter 3 verse 16", "John three sixteen", "First Thessalonians four thirteen". The verse must be detected in each case; if the detector misses a phrasing because of numeral formatting, report that rather than patching the detector in this branch.
6. A production build (`bun tauri build`) bundles the signed sidecar, and Bark works from the built app after downloading the model in Settings.

When finished, give me a short summary of what changed, anything that deviated from this plan, and a benchmark plan: Bark 3.0 vs Parakeet Ultra (download `FluidInference/parakeet-ultra-coreml` into `models/bark/parakeet-ultra` and point the one-shot sidecar at it) vs Whisper large-v3-turbo on two recorded sermons, measuring WER on verse references specifically, numeral formatting, and latency per segment.
