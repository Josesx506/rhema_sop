/** Converts an expanded SongBlock into the VerseRenderData the broadcast
 * store / output windows understand. */
import type { VerseRenderData } from "@/types/broadcast"
import type { SongBlock } from "@/types/songs"

/**
 * `noAutoFade: true` is critical — it stops the idle-fade timer from fading
 * lyrics out mid-song while the congregation is still singing a block.
 */
export function blockToRenderData(songTitle: string, block: SongBlock): VerseRenderData {
  return {
    reference: `${songTitle} — ${block.label}`,
    segments: block.lines.map((text) => ({ text })),
    noAutoFade: true,
  }
}
