# Changelog

Fork releases of Rhema (rhema_sop). Dates are release dates.

## Unreleased

### Fixed

- **NDI outputs fade and blank to transparent.** The idle fade and the Blank
  toggle never ran on an NDI feed at all: the fade was stepped by
  `requestAnimationFrame`, and an NDI output's window is hidden, so the
  browser never called it back. Blanking therefore only dropped the text and
  left the Lower Thirds plate sitting on the video as a grey band. The fade
  is now clock-driven on a timer and pushes each intermediate frame, and
  every NDI output fades to fully transparent rather than to black or the
  theme background — whatever the Idle Display setting says, which now only
  governs display outputs.
- **Slides and videos no longer black out an overlay feed.** Presentation
  content used to fill the entire frame on every output. It is now confined
  to the theme's background region, and a theme with a transparent
  background (Lower Thirds, any NDI overlay) declines it outright and keeps
  showing scripture or lyrics — a sermon slide on the projector no longer
  covers the camera the lower third is keyed over.
- **Importing a catalog no longer duplicates songs.** Every import path
  re-issues fresh song ids, so re-importing the same file, or the same
  ProPresenter bundle twice, piled up copies. Imports are now matched
  against the catalog by normalized title + artist (curly apostrophes and
  spacing folded), repeats inside a single file collapse too, and the toast
  reports what was skipped instead of claiming a successful import of
  nothing. Setlist loading uses the same identity rule.

### Changed

- The Idle Fade Timeout default is 60s, up from 30s. Existing installs keep
  whatever they had — change it in Settings → Display Mode.

## 0.4.2 — 2026-09-05

### Added

- **Save / open a setlist**: the setlist header's ⋮ menu writes the arranged
  service order to a JSON file and reads it back, so a Sunday order built
  once can be reopened instead of re-added song by song. The file embeds the
  songs it references, so it also opens on a machine whose catalog is missing
  them (those are added to the catalog); songs are matched by catalog id
  first, then by title + artist, so a re-imported catalog still resolves.
  Blocks are re-expanded from the catalog on load, so a song edited since the
  file was saved presents its current arrangement. Clear setlist moved into
  the same menu.
- **Verse / Song preview switch** in the theme designer toolbar: the canvas
  can lay out a six-line song block instead of the one-line sample verse, so
  a layout can be checked against lyrics before it goes on air.

### Fixed

- Detaching a theme into free positioning (dragging a frame on the designer
  canvas, or the "Free positioning" checkbox) no longer shrinks text on the
  output. The seeded boxes hugged the one-line sample verse, and free mode
  auto-fits content into its box — so every real verse, and every multi-line
  song block hardest, was squeezed into roughly one line's worth of height.
  Seeded boxes now span the theme's text area while keeping the text exactly
  where it was.

## 0.4.1 — 2026-08-29

### Added

- **ProPresenter 7 import**: the Songs tab's Import dropdown gains a
  "ProPresenter bundle" entry that reads `.proBundle` exports directly —
  titles, section labels (Verse/Chorus/Bridge), per-slide lyrics, and CCLI
  metadata. Media/countdown decks and exact duplicates are skipped with a
  summary. A CLI version lives at `data/convert-probundle.py` for
  converting bundles to catalog JSON outside the app.
- **Setlist arranging tools**: each song in the setlist can be collapsed to
  a single header line (chevron beside the title, block-count badge), with
  a collapse/expand-all button in the panel header and up/down arrows to
  reorder whole songs. Collapse is visual only — presentation order and
  arrow-key navigation still cover every block, and presenting into a
  collapsed song expands it.
- **Blank toggle** on the Live display: fades the output to just the theme
  background while remembering the live verse/song/slide, which return when
  the blank lifts. Presenting different content releases it automatically;
  transcript keepalive re-stamps of the same verse do not. Videos are
  unaffected.
- **Idle Display setting** (Settings → Display Mode): choose what a
  faded-out display shows — the theme background and logo (default) or a
  full black screen. Applies to both the idle fade and the Blank toggle;
  turning Live off always goes to black.
- **In-app Whisper model downloader** (Settings → Speech Recognition,
  Whisper provider): pick a model size (Tiny 42 MB → Large v3 Turbo
  834 MB) and download it straight from the official whisper.cpp
  repository with a progress bar — no bun install or manual file
  placement on a fresh machine. Models land in app-data and survive app
  updates; downloads can be cancelled and app-data models removed. The
  previously hardcoded model filename is now a setting.

### Changed

- Song lyrics now render their authored line breaks on the preview and
  live displays instead of wrapping as one paragraph. Scripture rendering
  is unchanged.
- The SOP theme vertically centers its text, so short blocks (one-line
  song slides) sit at screen center instead of the top of the text area.
- The Auto switch moved from the Live display header to the transcript
  panel, next to Start/Stop transcribing; the Settings "Broadcast Mode"
  radio now controls the same flag, so the two can never disagree. The
  Live display header carries just Blank and Go live.
- The interactive tutorial covers the fork layout: mode tabs
  (Scripture/Songs/Presentation), the Auto switch's new home, and the
  Blank toggle. Starting the tour switches to the Scripture view.
- Panel header titles and toggles stay on one line at the default window
  size.

### Fixed

- macOS production builds no longer fail compiling whisper.cpp: the
  deployment target is pinned to macOS 11.0 (matching CI), which
  `std::filesystem` in ggml requires.

## 0.4.0 — 2026-08-29

First fork feature release: songs (catalog, setlist, lyrics rendering),
PDF slide decks, video media loops, preview-before-live subtabs,
relevance-based idle fade with transcript keepalive, SOP theme + logo
overlay, and self-signed Windows packaging. See the v0.4.0 release notes.
