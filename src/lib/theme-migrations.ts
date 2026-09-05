import type {
  BroadcastTheme,
  ElementBox,
  SurfaceFill,
  VerseRenderData,
} from "@/types/broadcast"
import {
  computeVerseLayoutMetrics,
  type VerseLayoutMetrics,
} from "./verse-renderer"
import { DEFAULT_LOGO_OVERLAY } from "./builtin-themes"

/** Sample verse used wherever a layout must be computed without live data. */
export const SAMPLE_VERSE: VerseRenderData = {
  reference: "Genesis 1:1 (KJV)",
  segments: [
    {
      verseNumber: 1,
      text: "In the beginning God created the heaven and the earth.",
    },
  ],
}

const DEFAULT_VERSE_NUMBERS: BroadcastTheme["verseNumbers"] = {
  visible: true,
  fontSize: 18,
  color: "#ffffff",
  superscript: true,
}

/**
 * Surfaces gained an `image` fill after the first themes were saved; spread
 * this so the renderer never has to guess whether the key exists.
 */
const DEFAULT_SURFACE: SurfaceFill = {
  enabled: false,
  color: "#000000",
  opacity: 0.7,
  borderRadius: 0,
  padding: 0,
  image: null,
}

/** Fill surface defaults, preserving whatever the saved theme already set. */
export function normalizeSurface(
  surface: SurfaceFill | undefined
): SurfaceFill | undefined {
  if (!surface) return undefined
  return { ...DEFAULT_SURFACE, ...surface }
}

function isValidBox(box: ElementBox | undefined): box is ElementBox {
  return (
    box !== undefined &&
    [box.x, box.y, box.width, box.height].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    ) &&
    box.width > 0 &&
    box.height > 0
  )
}

/**
 * Fill defaults on themes loaded from disk, import, or IPC so older saved
 * themes (created before free positioning / verse-number styling existed)
 * keep working unchanged.
 */
export function normalizeTheme(theme: BroadcastTheme): BroadcastTheme {
  const layout = { ...theme.layout }
  layout.mode = layout.mode === "free" ? "free" : "stacked"
  if (
    layout.mode === "free" &&
    (!isValidBox(layout.referenceBox) || !isValidBox(layout.verseBox))
  ) {
    layout.mode = "stacked"
  }
  return {
    ...theme,
    verseNumbers: { ...DEFAULT_VERSE_NUMBERS, ...theme.verseNumbers },
    textBox: { ...DEFAULT_SURFACE, ...theme.textBox },
    verseText: {
      ...theme.verseText,
      surface: normalizeSurface(theme.verseText?.surface),
    },
    reference: {
      ...theme.reference,
      surface: normalizeSurface(theme.reference?.surface),
    },
    layout,
    // Back-fill for themes saved before logoOverlay existed.
    logoOverlay: theme.logoOverlay ?? DEFAULT_LOGO_OVERLAY,
  }
}

// Floor the origin and ceil the size (at 2 decimals) so the percent box is
// guaranteed to contain the source rect — a width rounded down would reduce
// the wrap width and re-flow the text on detach.
const rectToBox = (
  rect: { x: number; y: number; width: number; height: number },
  canvasW: number,
  canvasH: number
): ElementBox => ({
  x: Math.floor((rect.x / canvasW) * 10000) / 100,
  y: Math.floor((rect.y / canvasH) * 10000) / 100,
  width: Math.ceil((rect.width / canvasW) * 10000) / 100,
  height: Math.ceil((rect.height / canvasH) * 10000) / 100,
})

/**
 * Compute seed boxes for a theme directly (used by the properties panel's
 * "free positioning" toggle, where no designer metrics are at hand). Lays the
 * theme out in stacked mode against a sample verse and converts the resulting
 * rects.
 */
export function seedFreeBoxesForTheme(
  theme: BroadcastTheme,
  verse: VerseRenderData = SAMPLE_VERSE
): { referenceBox: ElementBox; verseBox: ElementBox } | null {
  const ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return null
  const stackedTheme: BroadcastTheme = {
    ...theme,
    layout: { ...theme.layout, mode: "stacked" },
  }
  const metrics = computeVerseLayoutMetrics(ctx, stackedTheme, verse)
  return seedFreeBoxesFromMetrics(metrics, theme.resolution)
}

/**
 * Grow a seeded element box so it owns real estate instead of hugging one
 * sample line. Horizontally every box spans the full text area; vertically it
 * expands away from the text in whichever direction its vertical alignment
 * keeps the sample anchored, bounded by `bounds`. The sample therefore renders
 * in exactly the same place after detaching, while longer content (a six-line
 * chorus, a wrapped verse) still has room instead of being auto-shrunk to fit
 * a one-line box.
 */
function expandBoxToBounds(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number },
  verticalAlign: "top" | "middle" | "bottom"
): { x: number; y: number; width: number; height: number } {
  const top = bounds.y
  const bottom = bounds.y + bounds.height
  const x = bounds.x
  const width = Math.max(rect.width, bounds.width)

  if (verticalAlign === "middle") {
    // Symmetric growth keeps the centre — and therefore centred text — put.
    const centre = rect.y + rect.height / 2
    const half = Math.max(rect.height / 2, Math.min(centre - top, bottom - centre))
    return { x, y: centre - half, width, height: half * 2 }
  }
  if (verticalAlign === "bottom") {
    const bottomEdge = rect.y + rect.height
    const y = Math.min(rect.y, top)
    return { x, y, width, height: Math.max(rect.height, bottomEdge - y) }
  }
  return { x, y: rect.y, width, height: Math.max(rect.height, bottom - rect.y) }
}

/**
 * Seed free-mode element boxes from stacked layout metrics (computed at
 * scale 1). Boxes span the theme's text area rather than hugging the sample
 * text: in free mode the renderer auto-fits the verse into its box, so a box
 * cut to one sample line would shrink every real verse — and every multi-line
 * song block hardest — the moment the theme was detached. Line breaks are
 * preserved: the sample already wrapped at the text-area width, so re-wrapping
 * at that same width reproduces the same lines.
 */
export function seedFreeBoxesFromMetrics(
  metrics: VerseLayoutMetrics,
  resolution: BroadcastTheme["resolution"]
): { referenceBox: ElementBox; verseBox: ElementBox } | null {
  const { referenceRect, verseRect, textRect, scaledTheme } = metrics
  if (!referenceRect || !verseRect) return null
  const { width: canvasW, height: canvasH } = resolution
  const bounds = textRect ?? {
    x: 0,
    y: 0,
    width: canvasW,
    height: canvasH,
  }

  // The verse never grows into the reference's band, so the two boxes stay
  // side by side the way the stacked layout had them.
  const verseBounds = { ...bounds }
  if (referenceRect.y + referenceRect.height <= verseRect.y) {
    const cut = Math.max(bounds.y, referenceRect.y + referenceRect.height)
    verseBounds.height = Math.max(verseRect.height, bounds.y + bounds.height - cut)
    verseBounds.y = cut
  } else if (referenceRect.y >= verseRect.y + verseRect.height) {
    const cut = Math.min(bounds.y + bounds.height, referenceRect.y)
    verseBounds.height = Math.max(verseRect.height, cut - bounds.y)
  }

  return {
    referenceBox: rectToBox(
      { ...referenceRect, x: bounds.x, width: Math.max(referenceRect.width, bounds.width) },
      canvasW,
      canvasH
    ),
    verseBox: rectToBox(
      expandBoxToBounds(
        verseRect,
        verseBounds,
        scaledTheme?.verseText?.verticalAlign ?? "top"
      ),
      canvasW,
      canvasH
    ),
  }
}
