/** Converts an expanded SongBlock into the VerseRenderData the broadcast
 * store / output windows understand. */
import type { VerseRenderData } from "@/types/broadcast"
import type { SongBlock } from "@/types/songs"

/**
 * Lyrics-only on the display: no "Title — Verse 1" header (reference is
 * empty), just the block's lines with the song title as a small footer
 * caption bottom-left (drawn by the renderer, ellipsis-truncated, clear of
 * the logo overlay).
 *
 * `noAutoFade: true` is critical — it stops the idle-fade timer from fading
 * lyrics out mid-song while the congregation is still singing a block.
 */
export function blockToRenderData(songTitle: string, block: SongBlock): VerseRenderData {
  return {
    reference: "",
    segments: block.lines.map((text) => ({ text, breakAfter: true })),
    noAutoFade: true,
    footerLabel: songTitle,
  }
}
