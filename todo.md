# Fork Roadmap — Extended Features (rhema_sop)

Working notes for features this fork adds on top of upstream (openbezal/rhema).
Design decided in conversation, implementation not started unless marked.

## Guiding architecture rule (all new modules)

New modules live in **new files**; shared/upstream files get only tiny,
additive "mount points" (a few lines each). This keeps `git merge upstream/main`
cheap — the Aug 2026 merge conflicted exactly where the fork edited shared
files and merged clean where it added files.

- New dirs are fork-owned: `src/components/songs/`, `src/components/slides/`,
  `src/stores/song-store.ts`, `src/lib/song-*.ts`, `src/types/songs.ts`, etc.
- Reuse the existing broadcast payload (`broadcast:verse-update` with
  `VerseRenderData`) instead of widening it. Adapters live in fork-owned files.
- If a new event is unavoidable (slides), add a parallel listener
  (`broadcast:slide-update`) rather than changing the existing payload shape.
- Merge upstream frequently (weekly-ish), keep merges as separate commits.
- Upstream genuinely general pieces when possible (e.g. idle fade) to shrink
  owned merge surface.

## Songs feature — DECIDED design (not yet implemented)

1. **Separate setlist, not the verse queue.** Songs get their own panel +
   store (setlist of songs, expanded block view). The existing
   `queue-store.ts` / `queue-panel.tsx` / `types/queue.ts` are NEVER edited
   (their verse dedupe logic is wrong for songs anyway — a chorus legitimately
   repeats). Verse queue and song setlist coexist; whatever was presented
   last from either owns the live output, so an operator can cut to a
   scripture mid-song and tap back to the current chorus block without
   losing position.
2. **One click queues a whole song** → its blocks materialize in arrangement
   order (V1 → C → V2 → C → Bridge → C) at queue time, each entry with its
   own id.
3. **Each block is one slide**: `{ sectionLabel, lines[] }` → adapter builds
   `VerseRenderData` (reference = "Song Title — Chorus", segments = lines)
   and emits the EXISTING `broadcast:verse-update`. Renderer/themes/outputs/
   idle-fade untouched.
4. **Free navigation**: active block index with next/prev stepping (same
   pattern as verse cycling) plus click-any-block jumping — repeats reachable
   both via arrangement expansion and ad hoc.
5. **Auto-split long blocks**: a block with too many lines splits into
   multiple slides at queue time (configurable lines-per-slide per song).
6. **Repeat markers**: consecutive repeats of the same section may collapse
   to a single entry labeled with a suffix — "Chorus (x2)", "(x4)" — at the
   end of the block label/line, instead of N identical consecutive entries.
7. Song library: CRUD, sections (verse/chorus/bridge), arrangement,
   plain-text / CCLI-style paste import. Persist via tauri-plugin-store like
   themes. Est. ~2–3k LOC frontend, ~0 Rust for MVP.
8. **Catalog & licensing (DECIDED)** — context: user's church is RCCG
   (Nigerian pentecostal; "Streams of Praise" parish branding already in
   the SOP theme).
   - DO NOT bundle copyrighted lyrics (contemporary Nigerian gospel —
     Sinach, Nathaniel Bassey, Dunsin Oyekan, Mercy Chinwo, etc. — or any
     modern worship catalog). Redistribution is infringement even though a
     church's CCLI license covers projecting them in-service.
   - NO bundled seed catalog (Open Hymnal ruled OUT by user). Ship exactly
     ONE sample song for viewing/testing — a public-domain hymn (e.g.
     "Amazing Grace") so nothing bundled has copyright exposure.
     Traditional/no-known-author Nigerian choruses are safe for users to
     enter themselves.
   - The church's own catalog is user-populated: paste import + OpenLyrics
     XML + OpenSong import (migrates existing OpenLP/OpenSong databases);
     accept CCLI SongSelect text paste. New songs addable any time (CRUD).
   - Store an optional CCLI song number per song and support showing the
     church's CCLI license number on the output (CCLI display requirement).
   - Catalog export/backup to JSON (portable between machines) — songs are
     persistent, labor-invested data, unlike session-only slides/media.

## Slides / presentation feature — DECIDED design (not yet implemented)

1. **Import: PDF only**, rendered to per-page images in-app via pdf.js.
   Covers PowerPoint/Keynote/Canva through their "export as PDF" path.
   No direct .pptx parsing. **Import-only — no in-app slide editor.**
2. **Session-only, never persisted.** Decks are uploaded via the UI each
   session and held in memory (rendered page bitmaps in the slide store);
   any slide artifacts are removed when the app closes. Unlike Bible verses
   / songs, nothing is written to tauri-plugin-store or app-data. This
   removes the need for any Rust storage command.
3. **Deck panel** mirrors songs-setlist conventions: slide strip/grid,
   click-any-slide jumping + next/prev stepping.
4. **Per-deck auto-advance loop** (every N seconds, looping — pre-service
   announcements use case) with full operator override: jump directly to a
   target slide, or pause/resume the loop entirely.
5. **Broadcast**: current slide goes full-frame to the live output via a NEW
   `broadcast:slide-update` event; the listener added in
   `broadcast-output.tsx` is the module's only shared-file mount point
   (~10 additive lines). Est. ~1–1.5k LOC frontend, 0 Rust.
6. **Slides bypass the theme system entirely (CONFIRMED)** — they are
   finished works with their own baked-in design. No background template,
   no logo watermark by default. The slide covers the frame fully or
   substantially (cover/contain against black is acceptable when aspect
   ratios differ). If an inbuilt slide editor is ever built (future),
   templates become relevant for IT only — not for imported decks.
7. **Idle fade-out does NOT apply to slides (CONFIRMED)** — announcement
   loops must never fade to black on their own.

## Media loops (pre-service announcements) — DECIDED: video-upload path

EasyWorship "mini movies" style. Two paths were weighed; **Path A chosen as
the far easier one**:

- **Path A (MVP): upload a looping video.** H.264 MP4 (decodes natively in
  WKWebView + WebView2). Session-only like slides, streamed from the picked
  file path via Tauri's asset protocol (never loaded into memory, nothing
  persisted). Display outputs: `<video loop>` in the output window. NDI
  outputs: draw video frames into the canvas via requestVideoFrameCallback
  → existing NDI frame-push. A few hundred LOC on top of the slides module.
- **Hybrid (later)**: looping video as the BACKGROUND layer with the
  existing theme text engine composited on top — "animated template with
  text" without building an animation editor. Modest work once Path A
  exists.
- **Path B (rejected/deferred)**: in-app animated-template editor
  (keyframes, timeline). Bigger than songs + slides combined; only
  reconsider if the fork grows contributors.

## Windows packaging & signing — DECIDED (descoped): self-signed cert

Scope clarified: NO public distribution planned. Signing exists only to
minimize install friction on the church's own PC(s); no long-term
maintenance wanted. **Full step-by-step instructions:
`documentation/windows-signing.md`** (cert generation on the Mac via
OpenSSL, per-release signing on the Mac via osslsigncode, one-time trust
import on the church PC). Dev is Mac-only; Windows installers come from
the existing GitHub Actions windows-latest job — nothing (bun/rust) is
ever installed on the PC. Tauri cross-compile from macOS was ruled out
(onnxruntime/NDI/whisper native deps).

- CI already builds Windows NSIS setup.exe + MSI (upstream
  `build-release.yml`), currently unsigned.
- **Chosen: self-signed code-signing certificate.** Generate once, sign
  installers via `bundle.windows.signCommand` in `tauri.conf.json`
  (locally or in CI), import the cert into the church PC's Trusted
  Publishers/Trusted Root store one time. Free, no Azure, no identity
  validation, no renewals. Cert only trusted on machines that imported it
  (fine for this scope).
- Useful facts: unsigned installers still install (SmartScreen interstitial
  is reputation-based and only fires on files with Mark-of-the-Web, i.e.
  internet downloads — USB-copied installers skip it entirely).
- **If distribution ever goes public**: switch to Azure Artifact Signing
  (formerly Trusted Signing, ~$10/mo) on a PERSONAL Azure account — not the
  Azure for Students account (billing-profile matching for gov-ID identity
  validation, university-tenant app-registration restrictions, account dies
  at graduation). GitHub↔Azure email mismatch is irrelevant (CI auth =
  service principal / OIDC secrets). Individual validation shows the
  user's legal personal name as publisher. Swapping certs later is a
  signCommand config change, not a redesign.
- Sign installer + app binary (+ updater artifacts if updater enabled).
- Sequencing decided: signing first, then songs MVP, then slides.

## Done

- 2026-08-29: Merged upstream/main (v0.3.2, 58 commits) keeping fork features
  (idle fade-out, logo/watermark overlay, SOP theme, auto_queued gate,
  optimum pip fix). Typecheck + 221 tests + build verified.
- 2026-08-29: Rebuilt semantic embedding index against runtime model
  (upstream provenance-checked pipeline) after startup self-check flagged
  the stale pre-merge index.
