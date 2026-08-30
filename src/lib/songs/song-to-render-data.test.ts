import { describe, expect, it } from "vitest"
import { blockToRenderData } from "./song-to-render-data"
import type { SongBlock } from "@/types/songs"

function makeBlock(overrides: Partial<SongBlock> = {}): SongBlock {
  return {
    id: "block-1",
    songId: "song-1",
    sectionId: "section-1",
    label: "Chorus",
    lines: ["Amazing grace", "how sweet the sound"],
    repeatCount: 1,
    ...overrides,
  }
}

describe("blockToRenderData", () => {
  it("shows lyrics only: empty reference, song title as the footer caption", () => {
    const data = blockToRenderData("Amazing Grace", makeBlock({ label: "Chorus (x2)" }))
    expect(data.reference).toBe("")
    expect(data.footerLabel).toBe("Amazing Grace")
  })

  it("maps each lyric line to a segment with just text", () => {
    const data = blockToRenderData("Amazing Grace", makeBlock({ lines: ["line one", "line two"] }))
    expect(data.segments).toEqual([
      { text: "line one", breakAfter: true },
      { text: "line two", breakAfter: true },
    ])
  })

  it("always sets noAutoFade so lyrics don't fade mid-song", () => {
    const data = blockToRenderData("Amazing Grace", makeBlock())
    expect(data.noAutoFade).toBe(true)
  })

  it("handles an empty lines array", () => {
    const data = blockToRenderData("Amazing Grace", makeBlock({ lines: [] }))
    expect(data.segments).toEqual([])
    expect(data.noAutoFade).toBe(true)
  })
})
