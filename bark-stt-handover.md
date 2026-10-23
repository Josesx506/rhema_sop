# Bark STT handover (resume from here)

Last updated: 2026-10-23. Branch: `feat/bark-stt`, commit `023b528` on top of `main` at `182c700` (v0.4.3). Nothing pushed. Spec is `bark-stt-prompt.md` in this directory.

## Status in one paragraph

The Bark provider is implemented, committed, and now proven on this Mac: the sidecar builds with Swift 6.1.2 (Command Line Tools 16.4 on macOS 15.8.1), the model is downloaded, one-shot and server modes both work, and the Rust provider ran end to end against the real sidecar through the shared segmenter. Spec done-when items 1 to 4 are complete. Items 5 (live mic test in the app) and 6 (production bundle and codesign check) are still open. The headline result is negative for Bark as shipped: it is 6 to 8 times faster than Whisper per segment but its number formatting defeats the verse detector. See "Benchmark results" below.

## Environment (resolved 2026-10-23)

macOS 15.8.1, Command Line Tools for Xcode 16.4 (Swift 6.1.2, SDK 15.5), Xcode 15.3 still in Applications but unused. Research toolchains were not touched beyond the CLT update. Model at `models/bark/bark-3.0` (21 files, 421 MB). Sidecar at `src-tauri/binaries/bark-sidecar-aarch64-apple-darwin` (gitignored, rebuild with `bun run build:bark-sidecar`).

## Commands (all verified working)

```
bun run build:bark-sidecar
bun run download:bark            # ~436 MB into models/bark/bark-3.0, skips the GPU-only encoder
src-tauri/binaries/bark-sidecar-aarch64-apple-darwin --model-dir models/bark/bark-3.0 --file <sermon.wav>
```

The one-shot mode prints transcript, word count, audio duration, inference time, confidence and RTFx. `--model-version ultra` is the default and is correct for Bark on FluidAudio 0.17.7. `--leading-silence 0.25` reproduces Conway's evaluation setup; default is 0.

For the Parakeet Ultra comparison, download `FluidInference/parakeet-ultra-coreml` into `models/bark/parakeet-ultra` (same file layout) and run the same command with that `--model-dir`.

Live test in the app: `bun tauri dev`, Settings, Speech Recognition, "Local (Bark)", download the model in the Bark section, start transcription, say "Turn with me to John chapter 3 verse 16", "John three sixteen", "First Thessalonians four thirteen". Record the literal transcript for each; numeral formatting (digits versus words) is undocumented for this model family and is the main detection risk.

Production check: `bun tauri build`, then `codesign -dv --entitlements - <app>/Contents/MacOS/bark-sidecar`.

## Benchmark plan (the actual goal of this work)

Bark 3.0 vs Parakeet Ultra vs Whisper large-v3-turbo on two recorded sermons. Measure WER on verse references specifically, numeral formatting, hallucinations during music or silence, and latency per segment. Context: Bark is not on the Open ASR Leaderboard; Conway's self-reported 7-dataset average is 4.94 versus 6.58 for Whisper turbo, and on FluidInference's Core ML LibriSpeech run Bark (4.96) scores below Parakeet v3 (4.12) and Ultra (3.81). Speed on the Neural Engine is roughly 140x real time for all three Parakeet-family builds. If Ultra wins, exposing it in the UI is small: the sidecar, resolver and downloader already take a model directory.

## What was verified on this Mac

- `cargo test --workspace`: green, including 16 new unit tests and 2 integration tests (fake sidecar and hung sidecar fixtures under `src-tauri/crates/stt/tests/`).
- `cargo clippy --workspace --all-features --all-targets`: zero warnings in new files; pre-existing pedantic warnings in detection, api, audio, deepgram and stt command files were left alone.
- `cargo check -p rhema --no-default-features --features whisper`: compiles, so the bark cfg gating is sound for Windows and Linux.
- `bun run test`: 28 files, 398 tests. `bunx tsc -b --noEmit` and eslint on new files clean.
- `bun run data/download-bark-model.ts --dry-run`: 21 files, 436 MB, Encoder_lut3 skipped.
- Swift: `swiftc -parse` on all files, plus a typecheck against a stub module written from the real FluidAudio v0.17.7 sources. Every API name used was confirmed against the tagged source.
- Whisper path: the extracted segmenter was diffed against the original loop; constants, thresholds, log strings and event order are identical.

## Residual risks

- Swift 6 strict-concurrency diagnostics may still appear at real compile time (the `Transcriber` class, the load-progress ticker task, top-level await in `main.swift`).
- Per-word confidence in `Transcriber.groupWords` recomputes token-to-word membership; if counts ever disagree it falls back to the segment confidence. Untested on real output.
- First launch compiles the encoder for the Neural Engine; the Rust ready timeout is 300 s and the sidecar logs progress every 15 s.
- Whether the detector accepts the numeral forms Bark emits is unknown until the live test.

## Judgment calls to revisit

- `src-tauri/build.rs` writes a placeholder sidecar script into `src-tauri/binaries/` when the real one is missing, because `externalBin` makes tauri-build refuse to compile without it. It warns on every cargo build and the build script overwrites it. A local `bun tauri build` without Swift 6 would bundle the placeholder; make it fail loudly instead if preferred. CI builds the real sidecar first.
- The sidecar removes the space before punctuation left by stripping `<unk>` tokens (Bark emits `<unk>` where a quotation mark would be). See `Transcriber.stripUnknownTokens`.
- After `stop()`, queued segments are still transcribed (Whisper parity) but each is capped at 3 s.
- `is_installed` in `bark_model.rs` requires `coremldata.bin` and `weights/weight.bin` inside each `.mlmodelc`, stricter than the spec's five top-level entries.
- A persisted `"bark"` provider on Windows or Linux falls back to Deepgram at hydration.
- Workspace `rust-version = "1.77.2"` is stale (code already needs 1.87+) and nothing enforces it. Not touched.

## File map

- `src-tauri/sidecars/bark-sidecar/` Swift package: `main.swift` (CLI, modes, macOS 15 check), `Protocol.swift` (frame reader, JSON writer), `Transcriber.swift` (FluidAudio wrapper), `README.md` (protocol and build notes)
- `scripts/build-bark-sidecar.sh` builds and copies to `src-tauri/binaries/bark-sidecar-aarch64-apple-darwin` (gitignored)
- `src-tauri/crates/stt/src/bark.rs` provider; `segmenter.rs` shared VAD buffering loop; `error.rs` adds `SidecarFailed`
- `src-tauri/src/commands/bark_model.rs` resolver, sidecar lookup, download/cancel/delete commands; `commands/stt.rs` has the `"bark"` arm
- `src-tauri/tauri.macos.conf.json` externalBin; `src-tauri/build.rs` placeholder logic
- `src/components/settings/bark-model-section.tsx`, `src/lib/platform.ts`, `src/stores/settings-store.ts`, `src/components/settings-dialog.tsx`
- `data/download-bark-model.ts`, package.json scripts `download:bark` and `build:bark-sidecar`
- `.github/workflows/build-release.yml` builds the sidecar on macOS before the Rust pre-build
- README "Local Bark STT (macOS)" and "Credits" sections; CHANGELOG Unreleased entry

## Upstream (openbezal/rhema) as of 2026-10-23

One commit ahead of the fork point (`0b0982c`, drops a flag in the model export scripts). Merges cleanly, no conflicts. No upstream work on alternative STT providers. Open upstream PRs #174 (update checker) and #183 (dual-language broadcast) would conflict mechanically with the fork's command registration and settings UI if merged later.

## Benchmark results (2026-10-23, macOS text-to-speech samples)

Two synthetic WAVs made with `say` (Samantha and Daniel voices), 16 kHz mono, 10 s and 18 s, containing 11 spoken references. Both providers ran through the identical VAD segmenter in a temporary rhema-stt integration test, then each Final transcript went through `DirectDetector::detect`. Scratch files: `/private/tmp/claude-501/-Users-ppersaud-Projects-rhema-sop/d7df61a6-99e9-4263-8ac5-d08e50597ac2/scratchpad/verses.wav` and `refs2.wav` (session temp, regenerate with `say` if gone).

| | Whisper large-v3-turbo q8 | Bark 3.0 (FluidAudio, ANE) |
|---|---|---|
| Model load | about 8 s | 71 s cold (ANE compile, once), 0.2 s warm |
| Inference, 10 s segment | 1.0 s | 0.15 s |
| Inference, 5 s segment | 0.53 s | 0.065 s |
| Correct detections out of 11 | 6 | 2 |
| False detections | 2 (Romans 1:1, Psalms 1:1 from "Romans 8 28" and "Psalm 23") | 0 |

How each model writes references:

- Whisper: "John 3.16", "1 Thessalonians 4.13", "2 Timothy 3.16", "Revelation 21.4", "Romans 8 28", "Genesis chapter 1 verse 1", "Matthew 5 verse 3", "Philemon 1-6". Dropped "Habakkuk" entirely.
- Bark: "John316", "Thessalonians4 13", "Romans828", "Psalm23", "Genesis chapter1, verse1", "Matthew5,3,", "second timothy316", "revelation214". Spoken "chapter three verse sixteen" stays as words and is detected. Wrote "habit" for Habakkuk and "the lemon" for Philemon (TTS pronunciation may share blame; Whisper got Philemon right). Short low-confidence segments come out lowercase without punctuation.

Confirmed by dumping word tokens from server mode: the glued forms are single tokens from the model itself. FluidAudio's inverse text normalization is not in the TDT decode path, and `--leading-silence 0.25` changes nothing.

Detector behaviour on Bark forms (probed directly): "John 3 16" and "Second Timothy 3:16" and "Matthew 5,3" are detected once a space separates book and digits; "John 316", "Romans 828", "Psalm 23", "Genesis chapter 1.1" are not. "Psalm 23" failing is pre-existing detector behaviour, not Bark related.

### What would make Bark usable

1. Detector change (the real fix, deliberately not done on this branch per the spec): when a book name is immediately followed by a digit run with no separator, or followed by a single digit run with a space, split the run using versification: try (chapter, verse) splits and keep those where the chapter exists and the verse is within range; prefer the split with the shorter chapter when both are valid. "316" in John is 3:16 only (John has 21 chapters); "828" in Romans is 8:28 only; "413" in 1 Thessalonians is 4:13 only; "214" in Revelation is ambiguous (2:14 and 21:4 both valid); "23" in Psalms is ambiguous (chapter 23 or 2:3); "16" in Philemon is 1:6 only (one chapter). This recovers most cases and would also fix Whisper's "Romans 8 28" false detection.
2. Provider-side normalization (cheap, inside `bark.rs` or the sidecar): insert a space at every letter-to-digit boundary inside a token. On its own this recovers only the punctuated forms ("Timothy3:16", "Matthew5,3"), so it is a complement to item 1, not a substitute.
3. Proper nouns: Bark missed Habakkuk and Philemon on synthetic speech. FluidAudio's custom-vocabulary boosting is documented for v2/v3 models, not ultra/Bark; worth testing with the 66 book names if item 1 lands.
4. Parakeet Ultra is untested here; download `FluidInference/parakeet-ultra-coreml` and rerun the same comparison. Its number formatting is probably the same family behaviour, so item 1 is needed regardless.

Verdict for now: keep Whisper as the default local provider. Bark is worth revisiting only after the detector learns to split glued chapter and verse digits; at that point its speed and lower hallucination risk make it attractive.

## Bark 3.0 Pro (checked 2026-10-23, not run)

Conway also publishes `ConwayResearch/Underdog-Bark-3.0-Pro`. Same 0.6B Parakeet TDT architecture and the same vocabulary as the base model; self-reported average WER 4.29 percent against 4.94 percent for Bark 3.0 (level with Parakeet v3, not ahead of it; no independent measurement yet).

| | Bark 3.0 (on disk now) | Bark 3.0 Pro |
|---|---|---|
| Core ML download | 421 MB | 1.23 GB |
| Encoder weights | 395 MB int8 (FluidInference build) | 1.2 GB FP16 (Conway build) |
| Packaging | `.mlmodelc` compiled | `.mlpackage` uncompiled, vocab named `parakeet_v3_vocab.json` |
| Encoder | single function | multi-function: `short8` (up to 8 s) and `full15` |

Why it is not a drop-in for the sidecar:

- `AsrModels.loadLocal` only accepts compiled `.mlmodelc` folders plus `parakeet_vocab.json`. Pro needs a loader branch that compiles the packages once with `MLModel.compileModel(at:)`, caches the output, reads the differently named vocab, and picks the encoder function per segment (our segments run 1 to 10 s, so `full15` for anything over 8 s).
- FluidAudio 0.17.7 already has the public `AsrModels(encoder:preprocessor:decoder:joint:configuration:vocabulary:version:)` initializer Conway's runner uses with `version: .ultra`, so no dependency bump. Conway's own demo package wants Swift 6.2 but that is their package, not ours.
- The in-app downloader points at the FluidInference repo. For a benchmark, download `coreml/*` and `NOTICE` by hand into `models/bark/bark-3.0-pro`.

Expectation: Pro probably still glues digits, since that comes from the training text and the shared vocabulary. A better fine-tune is more likely to help proper nouns (Habakkuk, Philemon). Running the comparison is about an hour: loader branch, 1.2 GB download, the same two clips, the same detector probe.

## Other uses for Bark (ideas, none started)

Bark gives three things the other providers do not at the same time: free local inference, 6 to 8 times Whisper's speed, and word timings with per-word confidence. Caveat for all of these: FluidAudio is macOS and iOS only, so they run on a Mac at the desk. The church Windows PC stays on Deepgram unless the model is ported through ONNX, which Conway has not published.

Ranked by fit with the existing code:

1. **Live captions on the broadcast output.** New consumer of the existing transcript stream feeding the NDI and lower-third layers. Word timings allow word-by-word captions in step with the speaker. Whisper is too slow for this and Deepgram costs per minute. Least new code of the list.
2. **Song following.** Transcribe sung worship and match it against the active setlist's blocks to suggest (not auto-present at first) the block being sung. The glued-digit failure is irrelevant for lyrics, speed and confidence weighting help, and the closed candidate set tolerates high word error rates. Unknown: neither model is trained on singing, so this needs one or two real worship recordings from the desk mix plus their catalog entries before any commitment. First step is an offline harness: WAV plus catalog JSON in, WER against the lyrics and simulated block-match accuracy out, for both Bark and Whisper.
3. **Bark as a fast first pass in front of Whisper.** Bark reads every segment in 0.15 s; only segments containing a book name go to Whisper for accurate numbers. Cuts Whisper load to a fraction and removes the transcript backlog on slow machines. Variant: Bark shows a provisional detection at once, Whisper confirms or corrects a second later.
4. **Sermon archive and search.** Batch-transcribe recorded services at well over 60 times real time, store timestamped text in the notes crate, index it with the embedding model semantic detection already uses. Search past sermons by topic or verse and jump to the moment.
5. **Service structure markers.** FluidAudio also ships VAD and speaker diarization; the sidecar could expose both. Gives worship/announcement/preaching boundaries and preacher versus guest reader separation for the archive and for mode switching.
6. **Operator voice commands.** A short grammar over the live transcript ("next slide", "show the verse") driving the api crate's remote command surface. FluidAudio's beta custom-vocabulary CTC head would make the phrases reliable. Needs a confirmation step or push-to-talk so a sermon never triggers it.
7. **Mic and pacing diagnostics.** Average word confidence per minute as a bad-mic or dropout signal; words per minute and speaking time as sermon statistics for the notes panel.

Recommendation: items 1 and 3 give the most benefit for the least new code and reuse the provider as it is on the branch. Item 2 has the highest upside but is the only one that needs new audio to validate first.
