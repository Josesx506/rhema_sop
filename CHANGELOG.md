# Changelog

Fork releases of Rhema (rhema_sop). Dates are release dates.

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
