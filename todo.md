# Fork Roadmap — rhema_sop

Working notes for this fork of upstream (openbezal/rhema). Shipped work is
pruned from this file — see git history and the v0.4.0 release notes.

## Guiding architecture rule (permanent)

New modules live in **new fork-owned files**; shared/upstream files get only
tiny, additive "mount points" (a few lines each), keeping
`git merge upstream/main` cheap. Merge upstream frequently (weekly-ish) as
separate commits. Upstream genuinely general pieces when possible to shrink
owned merge surface. Proven twice: the 58-commit upstream merge conflicted
only where the fork edited shared files, and v0.4.0 shipped ~5.9k added
lines with under 60 touched upstream lines.

## Open — upstream contributions

- PR branches pushed to the fork, awaiting PRs via the GitHub UI (compare
  links in session notes): `feat/idle-fade-timeout` (idle fade + relevance
  keepalive), `feat/live-output-guards` (live-display safety toasts).
- Candidate PR: free-mode box seeding (`seedFreeBoxesFromMetrics`). Upstream
  seeds the boxes tight around the one-line SAMPLE_VERSE, and free mode
  auto-fits content into its box — so detaching any theme silently shrinks
  every longer verse (and every song block) on the output. Fixed here by
  seeding boxes that span the text area while keeping the sample text put.
- Candidate third PR: the fork-gate on the Pages deploy workflow
  (`if: github.repository == 'openbezal/rhema'`) — courtesy to all forks.
- Worth reporting to pdf.js: their "legacy" build transpiles syntax but not
  missing runtime APIs (`ArrayBuffer.transferToFixedLength` broke WKWebView
  on macOS 14). Fork carries a polyfill in
  `src/lib/slides/arraybuffer-transfer-polyfill.ts` — remember it when
  bumping pdfjs-dist.

## Future features

1. **Benchmark-based Whisper model recommendation** — the downloader +
   model-size setting SHIPPED in 0.4.1 (Settings → Speech Recognition:
   curated model picker, streaming download into app-data, cancel/remove;
   `commands/whisper_model.rs` + `whisper-model-section.tsx`). Remaining
   future piece:
   - Benchmark, don't guess: fetch the `tiny` model (~40 MB), transcribe a
     bundled ~5 s audio sample, measure real-time factor, extrapolate with
     whisper.cpp's known inter-model speed ratios, and recommend the
     largest model predicted at RTF ≤ ~0.6. Operator can override.
   - Surface the measured RTF in diagnostics ("this machine transcribes at
     0.4× real time with small").
2. **Media loops hybrid** — looping video as the BACKGROUND layer with the
   existing theme text engine composited on top ("animated template with
   text" without building an animation editor). Modest work now that video
   loops exist.
3. **Slide editor (far future, only if ever needed)** — reuse the theme
   designer to compose text-on-background slides in-app; templates become
   relevant for it. Imported decks stay template-free.
4. **Remote-command surface for songs/slides** — extend upstream's remote
   control (next/prev block, next slide, stop media) for a phone/tablet
   operator.
5. **Semantic detection on Windows (optional)** — installer bundles the
   Bible DB but not the 121 MB embeddings index + ONNX model; decide
   whether to ship them (installer bloat) or add an in-app download like
   the Whisper one. FTS/keyword detection works fully without them.

## Known remaining NDI gaps

- A playing video pushes NDI frames only on its start burst and the 2s
  keepalive — the rVFC pump redraws the canvas but never pushes — so video on
  an NDI feed arrives as a near-slideshow. Needs an fps-throttled push in the
  presentation redraw callback (`broadcast-output.tsx`). The idle fade got its
  own per-tick push in the same subsystem; reuse that shape.

## Deployment state (church Windows PC)

- v0.4.0 NSIS installer, self-signed cert imported (Trusted Root +
  Trusted Publishers) — installs clean. Signing docs:
  `documentation/windows-signing.md`.
- **STT: Deepgram (cloud) only** — requires the API key + internet at the
  desk. Local Whisper large-v3-turbo measured slower than real time on
  this PC (99% CPU, unbounded transcript backlog); `small` renamed into
  the model slot is the offline fallback until feature 1 lands.
- Whisper model resolution (since 0.4.1): dev tree →
  `<app-data>\models\whisper\<selected file>` (in-app download) →
  `<install dir>\models\whisper\<selected file>` (legacy manual
  placement). Model file is a Setting; default remains
  `ggml-large-v3-turbo-q8_0.bin`.
