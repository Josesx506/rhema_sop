import { describe, expect, it } from "vitest"
import {
  buildSetlistExport,
  parseSetlistExport,
  resolveSetlist,
  type SetlistExport,
} from "./setlist-file"
import type { SetlistEntry, Song } from "@/types/songs"

function song(id: string, title: string, artist = ""): Song {
  return {
    id,
    title,
    artist,
    sections: [
      { id: `${id}-v1`, label: "Verse 1", lines: ["line one", "line two"] },
      { id: `${id}-c`, label: "Chorus", lines: ["chorus line"] },
    ],
    arrangement: [`${id}-v1`, `${id}-c`],
    createdAt: 1,
    updatedAt: 1,
  }
}

function entry(s: Song): SetlistEntry {
  return { id: `entry-${s.id}`, songId: s.id, title: s.title, blocks: [] }
}

describe("buildSetlistExport", () => {
  it("records the order and embeds each referenced catalog song once", () => {
    const grace = song("a", "Amazing Grace", "John Newton")
    const fount = song("b", "Come Thou Fount")
    const catalog = [grace, fount, song("c", "Unused")]
    const setlist = [entry(fount), entry(grace), entry(fount)]

    const payload = buildSetlistExport(setlist, catalog, 42)

    expect(payload.format).toBe("rhema-setlist")
    expect(payload.exportedAt).toBe(42)
    expect(payload.entries.map((e) => e.title)).toEqual([
      "Come Thou Fount",
      "Amazing Grace",
      "Come Thou Fount",
    ])
    expect(payload.entries[1].artist).toBe("John Newton")
    // Deduplicated, and the untouched catalog song is not dragged along.
    expect(payload.songs.map((s) => s.id)).toEqual(["b", "a"])
  })

  it("falls back to the entry title when the catalog song was deleted", () => {
    const payload = buildSetlistExport(
      [{ id: "e1", songId: "gone", title: "Deleted Song", blocks: [] }],
      []
    )
    expect(payload.entries[0]).toEqual({
      songId: "gone",
      title: "Deleted Song",
      artist: "",
    })
    expect(payload.songs).toEqual([])
  })
})

describe("parseSetlistExport", () => {
  it("rejects non-JSON", () => {
    expect(() => parseSetlistExport("nope")).toThrow(/not valid JSON/)
  })

  it("rejects a JSON file that is not a setlist export", () => {
    expect(() =>
      parseSetlistExport(JSON.stringify({ format: "rhema-song-catalog", songs: [] }))
    ).toThrow(/not a Rhema setlist export/)
  })

  it("accepts a valid export and defaults the songs array", () => {
    const parsed = parseSetlistExport(
      JSON.stringify({
        format: "rhema-setlist",
        version: 1,
        exportedAt: 7,
        entries: [{ songId: "a", title: "T", artist: "" }],
      })
    )
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.songs).toEqual([])
  })
})

describe("resolveSetlist", () => {
  const grace = song("a", "Amazing Grace", "John Newton")
  const fount = song("b", "Come Thou Fount")
  const payload: SetlistExport = {
    format: "rhema-setlist",
    version: 1,
    exportedAt: 0,
    entries: [
      { songId: "a", title: "Amazing Grace", artist: "John Newton" },
      { songId: "b", title: "Come Thou Fount", artist: "" },
    ],
    songs: [grace, fount],
  }

  it("matches songs already in the catalog by id and adds nothing", () => {
    const resolved = resolveSetlist(payload, [grace, fount])
    expect(resolved.songs.map((s) => s.id)).toEqual(["a", "b"])
    expect(resolved.added).toEqual([])
    expect(resolved.missing).toEqual([])
  })

  it("matches by title + artist when the catalog was re-imported with new ids", () => {
    const reimported = [
      { ...grace, id: "new-a" },
      { ...fount, id: "new-b" },
    ]
    const resolved = resolveSetlist(payload, reimported)
    expect(resolved.songs.map((s) => s.id)).toEqual(["new-a", "new-b"])
    expect(resolved.added).toEqual([])
  })

  it("adds embedded songs the catalog is missing, with fresh ids", () => {
    const resolved = resolveSetlist(payload, [grace])
    expect(resolved.added).toHaveLength(1)
    const added = resolved.added[0]
    expect(added.title).toBe("Come Thou Fount")
    expect(added.id).not.toBe("b")
    // Section ids are freshened too, and the arrangement follows them.
    expect(added.sections.map((s) => s.id)).not.toContain("b-v1")
    expect(added.arrangement).toEqual(added.sections.map((s) => s.id))
    expect(resolved.songs[1]).toBe(added)
  })

  it("adds a repeated missing song only once", () => {
    const repeated: SetlistExport = {
      ...payload,
      entries: [payload.entries[1], payload.entries[1]],
      songs: [fount],
    }
    const resolved = resolveSetlist(repeated, [])
    expect(resolved.added).toHaveLength(1)
    expect(resolved.songs).toHaveLength(2)
    expect(resolved.songs[0]).toBe(resolved.songs[1])
  })

  it("reports entries it cannot resolve at all instead of dropping them silently", () => {
    const orphan: SetlistExport = {
      ...payload,
      entries: [{ songId: "ghost", title: "Ghost Song", artist: "" }],
      songs: [],
    }
    const resolved = resolveSetlist(orphan, [])
    expect(resolved.songs).toEqual([])
    expect(resolved.missing).toEqual(["Ghost Song"])
  })
})
