/**
 * Fork: what the theme designer's canvas previews.
 *
 * The designer only ever laid out one short scripture line, so a layout that
 * looked right there could still squeeze a six-line chorus on the real output
 * — the failure was invisible until Sunday. This lets the operator flip the
 * canvas between a scripture verse and a song block (the two shapes the
 * renderer actually has to serve) while designing.
 *
 * Fork-owned: design-canvas.tsx only reads the current sample and re-renders
 * when it changes.
 */
import { create } from "zustand"
import type { VerseRenderData } from "@/types/broadcast"
import { SAMPLE_VERSE } from "@/lib/theme-migrations"

export type PreviewSampleKind = "verse" | "song"

/**
 * A worst-case-ish lyric block: six authored lines, no reference, song title
 * in the footer — exactly what `blockToRenderData` emits for a setlist block.
 * "Amazing Grace" (John Newton, 1779) is public domain.
 */
const SAMPLE_SONG: VerseRenderData = {
  reference: "",
  footerLabel: "Amazing Grace",
  noAutoFade: true,
  segments: [
    { text: "Amazing grace, how sweet the sound", breakAfter: true },
    { text: "That saved a wretch like me", breakAfter: true },
    { text: "I once was lost, but now am found", breakAfter: true },
    { text: "Was blind, but now I see", breakAfter: true },
    { text: "'Twas grace that taught my heart to fear", breakAfter: true },
    { text: "And grace my fears relieved", breakAfter: true },
  ],
}

const SAMPLES: Record<PreviewSampleKind, VerseRenderData> = {
  verse: SAMPLE_VERSE,
  song: SAMPLE_SONG,
}

interface PreviewSampleState {
  kind: PreviewSampleKind
  setKind: (kind: PreviewSampleKind) => void
}

export const usePreviewSample = create<PreviewSampleState>((set) => ({
  kind: "verse",
  setKind: (kind) => set({ kind }),
}))

/** The render data the designer canvas should lay out right now. */
export function currentPreviewSample(): VerseRenderData {
  return SAMPLES[usePreviewSample.getState().kind]
}
