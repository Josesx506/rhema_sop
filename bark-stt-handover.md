# Bark STT handover (resume from here)

Last updated: 2026-10-23. Branch: `feat/bark-stt`, commit `023b528` on top of `main` at `182c700` (v0.4.3). Nothing pushed. Spec is `bark-stt-prompt.md` in this directory.

## Status in one paragraph

The Bark provider is fully implemented and committed: Swift sidecar, Rust provider, Tauri wiring, in-app model downloader, frontend option, docs, CI step. Every check that can run on this Mac passes. The sidecar has never been compiled or executed, because this Mac is macOS 14.0 with Swift 5.10 and the Bark Core ML model needs macOS 15 and FluidAudio needs Swift 6. Done-when items 3 to 6 of the spec are open.

## Decision pending: how to get a build environment

The dev Mac also hosts research toolchains (CPS, hole tomography, specfwat and similar Fortran/MPI/Homebrew stacks), so a jump to macOS 27 is risky. Options, lowest risk first:

1. Stay on macOS 14, apply the 14.x point update (14.5 or later), install Xcode 16 from the App Store, `xcode-select -s /Applications/Xcode.app`. Gives Swift 6, so the sidecar builds and Parakeet Ultra (macOS 14 compatible) can be benchmarked. Bark itself still needs macOS 15.
2. Add an APFS volume in Disk Utility, install macOS 15 or 27 on it, boot into it only for Rhema. Main volume untouched.
3. Upgrade the main volume to macOS 15 (not 27). Rebuild Homebrew formulae, gfortran, MPI afterwards. Time Machine first.

Suggested: option 1 now, option 2 when ready to run Bark itself.

## Commands once Swift 6 is available

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
