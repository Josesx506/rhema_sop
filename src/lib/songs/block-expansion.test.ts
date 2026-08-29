import { describe, expect, it } from "vitest"
import { expandSong } from "./block-expansion"
import type { Song, SongSection } from "@/types/songs"

function makeSection(overrides: Partial<SongSection> = {}): SongSection {
  return { id: crypto.randomUUID(), label: "Verse 1", lines: ["line one", "line two"], ...overrides }
}

function makeSong(overrides: Partial<Song> = {}): Song {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: "Test Song",
    artist: "",
    sections: [],
    arrangement: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("expandSong", () => {
  it("uses authored section order when arrangement is empty", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a", "b"] })
    const c = makeSection({ label: "Chorus", lines: ["c", "d"] })
    const song = makeSong({ sections: [v1, c], arrangement: [] })

    const blocks = expandSong(song)

    expect(blocks.map((b) => b.label)).toEqual(["Verse 1", "Chorus"])
    expect(blocks.map((b) => b.sectionId)).toEqual([v1.id, c.id])
  })

  it("follows the arrangement order over authored order", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a"] })
    const c = makeSection({ label: "Chorus", lines: ["b"] })
    const song = makeSong({ sections: [v1, c], arrangement: [c.id, v1.id, c.id] })

    const blocks = expandSong(song)

    // c, v1, c — no two c's are consecutive, so nothing collapses.
    expect(blocks.map((b) => b.label)).toEqual(["Chorus", "Verse 1", "Chorus"])
  })

  it("skips arrangement entries referencing a missing section", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a"] })
    const song = makeSong({ sections: [v1], arrangement: [v1.id, "missing-id"] })

    const blocks = expandSong(song)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].label).toBe("Verse 1")
  })

  it("auto-splits a section longer than linesPerBlock into labeled parts", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a", "b", "c", "d", "e"] })
    const song = makeSong({ sections: [v1], arrangement: [v1.id], linesPerBlock: 2 })

    const blocks = expandSong(song)

    expect(blocks.map((b) => b.label)).toEqual(["Verse 1 (1/3)", "Verse 1 (2/3)", "Verse 1 (3/3)"])
    expect(blocks.map((b) => b.lines)).toEqual([["a", "b"], ["c", "d"], ["e"]])
    expect(blocks.every((b) => b.repeatCount === 1)).toBe(true)
  })

  it("does not split when linesPerBlock is 0 or unset", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a", "b", "c", "d", "e"] })
    const songZero = makeSong({ sections: [v1], arrangement: [v1.id], linesPerBlock: 0 })
    const songUnset = makeSong({ sections: [v1], arrangement: [v1.id] })

    expect(expandSong(songZero)).toHaveLength(1)
    expect(expandSong(songUnset)).toHaveLength(1)
    expect(expandSong(songUnset)[0].lines).toEqual(["a", "b", "c", "d", "e"])
  })

  it("does not split when the section is exactly linesPerBlock long", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a", "b"] })
    const song = makeSong({ sections: [v1], arrangement: [v1.id], linesPerBlock: 2 })

    const blocks = expandSong(song)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].label).toBe("Verse 1")
  })

  it("collapses consecutive repeats of the same section into one block with repeatCount", () => {
    const c = makeSection({ label: "Chorus", lines: ["sing", "along"] })
    const song = makeSong({ sections: [c], arrangement: [c.id, c.id, c.id] })

    const blocks = expandSong(song)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].label).toBe("Chorus (x3)")
    expect(blocks[0].repeatCount).toBe(3)
    expect(blocks[0].lines).toEqual(["sing", "along"])
  })

  it("does NOT collapse non-consecutive repeats of the same section", () => {
    const v1 = makeSection({ label: "Verse 1", lines: ["a"] })
    const c = makeSection({ label: "Chorus", lines: ["b"] })
    const song = makeSong({ sections: [v1, c], arrangement: [v1.id, c.id, v1.id, c.id] })

    const blocks = expandSong(song)

    expect(blocks).toHaveLength(4)
    expect(blocks.map((b) => b.label)).toEqual(["Verse 1", "Chorus", "Verse 1", "Chorus"])
    expect(blocks.every((b) => b.repeatCount === 1)).toBe(true)
  })

  it("collapses split parts across a consecutive repeat run, tagging every part with the repeat count", () => {
    // Chorus has 4 lines, splits into 2 parts of 2. It repeats twice in a row.
    const c = makeSection({ label: "Chorus", lines: ["a", "b", "c", "d"] })
    const song = makeSong({ sections: [c], arrangement: [c.id, c.id], linesPerBlock: 2 })

    const blocks = expandSong(song)

    // Two consecutive occurrences collapse into the section's 2 parts, not 4.
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.label)).toEqual(["Chorus (1/2) (x2)", "Chorus (2/2) (x2)"])
    expect(blocks.every((b) => b.repeatCount === 2)).toBe(true)
    expect(blocks.map((b) => b.lines)).toEqual([["a", "b"], ["c", "d"]])
  })

  it("does not collapse split parts when the runs are not a pure consecutive repeat", () => {
    const c = makeSection({ label: "Chorus", lines: ["a", "b", "c", "d"] })
    const v1 = makeSection({ label: "Verse 1", lines: ["x"] })
    const song = makeSong({ sections: [c, v1], arrangement: [c.id, v1.id, c.id], linesPerBlock: 2 })

    const blocks = expandSong(song)

    // Each Chorus occurrence is its own run of 1, so each splits independently.
    expect(blocks.map((b) => b.label)).toEqual([
      "Chorus (1/2)",
      "Chorus (2/2)",
      "Verse 1",
      "Chorus (1/2)",
      "Chorus (2/2)",
    ])
    expect(blocks.every((b) => b.repeatCount === 1)).toBe(true)
  })

  it("gives every generated block a unique id", () => {
    const c = makeSection({ label: "Chorus", lines: ["a", "b", "c", "d"] })
    const song = makeSong({ sections: [c], arrangement: [c.id, c.id], linesPerBlock: 2 })

    const blocks = expandSong(song)
    const ids = new Set(blocks.map((b) => b.id))
    expect(ids.size).toBe(blocks.length)
  })
})
