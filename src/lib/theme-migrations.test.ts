import { describe, expect, it } from "vitest"
import type { BroadcastTheme } from "@/types/broadcast"
import { BUILTIN_THEMES } from "./builtin-themes"
import { normalizeTheme, seedFreeBoxesFromMetrics } from "./theme-migrations"
import type { VerseLayoutMetrics } from "./verse-renderer"

const stackedBase = BUILTIN_THEMES[0]

describe("normalizeTheme — surfaces", () => {
  it("fills in the container's image key for themes saved before surfaces", () => {
    const legacy = {
      ...stackedBase,
      textBox: {
        enabled: true,
        color: "#111111",
        opacity: 0.5,
        borderRadius: 8,
        padding: 12,
      },
    } as unknown as BroadcastTheme

    const normalized = normalizeTheme(legacy)
    expect(normalized.textBox.image).toBeNull()
    // Everything the theme did specify survives.
    expect(normalized.textBox).toMatchObject({
      enabled: true,
      color: "#111111",
      opacity: 0.5,
      borderRadius: 8,
      padding: 12,
    })
  })

  it("leaves per-element surfaces undefined when absent", () => {
    const normalized = normalizeTheme(stackedBase)
    expect(normalized.reference.surface).toBeUndefined()
    expect(normalized.verseText.surface).toBeUndefined()
  })

  it("fills defaults into a partially specified element surface", () => {
    const theme = {
      ...stackedBase,
      reference: {
        ...stackedBase.reference,
        surface: { enabled: true, color: "#222222" },
      },
    } as unknown as BroadcastTheme

    const surface = normalizeTheme(theme).reference.surface!
    expect(surface.enabled).toBe(true)
    expect(surface.color).toBe("#222222")
    expect(surface.image).toBeNull()
    expect(typeof surface.borderRadius).toBe("number")
    expect(typeof surface.padding).toBe("number")
  })
})

describe("normalizeTheme", () => {
  it("defaults layout.mode to stacked for legacy themes", () => {
    const legacy = {
      ...stackedBase,
      layout: { ...stackedBase.layout, mode: undefined },
    }
    expect(normalizeTheme(legacy).layout.mode).toBe("stacked")
  })

  it("keeps free mode when both boxes are valid", () => {
    const theme: BroadcastTheme = {
      ...stackedBase,
      layout: {
        ...stackedBase.layout,
        mode: "free",
        referenceBox: { x: 5, y: 5, width: 50, height: 10 },
        verseBox: { x: 5, y: 20, width: 60, height: 50 },
      },
    }
    expect(normalizeTheme(theme).layout.mode).toBe("free")
  })

  it("demotes free mode to stacked when boxes are missing", () => {
    const theme: BroadcastTheme = {
      ...stackedBase,
      layout: { ...stackedBase.layout, mode: "free" },
    }
    expect(normalizeTheme(theme).layout.mode).toBe("stacked")
  })

  it("demotes free mode to stacked when a box has non-finite values", () => {
    const theme: BroadcastTheme = {
      ...stackedBase,
      layout: {
        ...stackedBase.layout,
        mode: "free",
        referenceBox: { x: NaN, y: 0, width: 50, height: 10 },
        verseBox: { x: 5, y: 20, width: 60, height: 50 },
      },
    }
    expect(normalizeTheme(theme).layout.mode).toBe("stacked")
  })

  it("fills verse number defaults for themes missing the field", () => {
    const legacy = {
      ...stackedBase,
      verseNumbers: undefined,
    } as unknown as BroadcastTheme
    const normalized = normalizeTheme(legacy)
    expect(normalized.verseNumbers).toEqual({
      visible: true,
      fontSize: 18,
      color: "#ffffff",
      superscript: true,
    })
  })

  it("preserves existing verse number settings", () => {
    const normalized = normalizeTheme(stackedBase)
    expect(normalized.verseNumbers).toEqual(stackedBase.verseNumbers)
  })
})

describe("seedFreeBoxesFromMetrics", () => {
  const metrics = {
    textRect: { x: 192, y: 108, width: 1536, height: 864 },
    referenceRect: { x: 500, y: 200, width: 400, height: 72 },
    verseRect: { x: 300, y: 300, width: 900, height: 400 },
  } as VerseLayoutMetrics

  it("spans the text area instead of hugging the sample text", () => {
    const seeded = seedFreeBoxesFromMetrics(metrics, {
      width: 1920,
      height: 1080,
    })
    expect(seeded).toEqual({
      // Full text-area width, the reference's own single-line band.
      referenceBox: { x: 10, y: 18.51, width: 80, height: 6.67 },
      // Top-aligned verse keeps its top edge and grows to the text-area floor.
      verseBox: { x: 10, y: 27.77, width: 80, height: 62.23 },
    })
  })

  it("grows a middle-aligned verse box symmetrically so the text stays put", () => {
    const middleMetrics = {
      ...metrics,
      scaledTheme: { verseText: { verticalAlign: "middle" } },
    } as unknown as VerseLayoutMetrics
    const seeded = seedFreeBoxesFromMetrics(middleMetrics, {
      width: 1920,
      height: 1080,
    })!
    const boxTop = (seeded.verseBox.y / 100) * 1080
    const boxCentre = boxTop + (seeded.verseBox.height / 100) * 1080 / 2
    const rectCentre = metrics.verseRect!.y + metrics.verseRect!.height / 2
    expect(boxCentre).toBeCloseTo(rectCentre, 0)
  })

  it("never seeds a box smaller than its source rect", () => {
    const seeded = seedFreeBoxesFromMetrics(metrics, {
      width: 1920,
      height: 1080,
    })!
    expect((seeded.verseBox.width / 100) * 1920).toBeGreaterThanOrEqual(
      metrics.verseRect!.width
    )
    expect((seeded.verseBox.height / 100) * 1080).toBeGreaterThanOrEqual(
      metrics.verseRect!.height
    )
  })

  it("keeps the verse box clear of the reference band", () => {
    const seeded = seedFreeBoxesFromMetrics(metrics, {
      width: 1920,
      height: 1080,
    })!
    const refBottom = seeded.referenceBox.y + seeded.referenceBox.height
    expect(seeded.verseBox.y).toBeGreaterThanOrEqual(refBottom)
  })

  it("returns null when an element rect is missing", () => {
    const withoutRef = { ...metrics, referenceRect: null } as VerseLayoutMetrics
    expect(
      seedFreeBoxesFromMetrics(withoutRef, { width: 1920, height: 1080 })
    ).toBeNull()
  })
})
