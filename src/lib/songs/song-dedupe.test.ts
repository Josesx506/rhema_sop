import { describe, expect, it } from "vitest"
import { dedupeIncomingSongs, songIdentityKey } from "./song-dedupe"
import type { Song } from "@/types/songs"

function song(id: string, title: string, artist = ""): Song {
  return {
    id,
    title,
    artist,
    sections: [{ id: `${id}-v1`, label: "Verse 1", lines: ["line one"] }],
    arrangement: [`${id}-v1`],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("songIdentityKey", () => {
  it("ignores case, surrounding space, and collapses internal whitespace", () => {
    expect(songIdentityKey({ title: "  Amazing   Grace ", artist: "JOHN Newton" })).toBe(
      songIdentityKey({ title: "amazing grace", artist: "john newton" })
    )
  })

  it("treats newlines and tabs as ordinary whitespace", () => {
    expect(songIdentityKey({ title: "Come\tThou\nFount", artist: "" })).toBe(
      songIdentityKey({ title: "Come Thou Fount", artist: "" })
    )
  })

  it("treats curly apostrophes as straight ones", () => {
    expect(songIdentityKey({ title: "Jesus’ Name", artist: "O‘Brien" })).toBe(
      songIdentityKey({ title: "Jesus' Name", artist: "O'Brien" })
    )
  })

  it("normalizes decomposed Unicode to NFC", () => {
    const decomposed = "Fide\u0301lite\u0301"
    const precomposed = "Fid\u00e9lit\u00e9"
    expect(decomposed).not.toBe(precomposed)
    expect(songIdentityKey({ title: decomposed, artist: "" })).toBe(
      songIdentityKey({ title: precomposed, artist: "" })
    )
  })

  it("keeps different songs apart, including same title by different artists", () => {
    expect(songIdentityKey({ title: "Grace", artist: "A" })).not.toBe(
      songIdentityKey({ title: "Grace", artist: "B" })
    )
    expect(songIdentityKey({ title: "Grace", artist: "" })).not.toBe(
      songIdentityKey({ title: "Peace", artist: "" })
    )
  })

  it("tolerates a missing artist", () => {
    expect(songIdentityKey({ title: "Grace" } as Pick<Song, "title" | "artist">)).toBe(
      songIdentityKey({ title: "Grace", artist: "" })
    )
  })
})

describe("dedupeIncomingSongs", () => {
  it("drops incoming songs already in the catalog, whatever their id", () => {
    const existing = [song("a", "Amazing Grace", "John Newton")]
    const incoming = [song("fresh-1", "amazing  GRACE", "john newton"), song("fresh-2", "New One")]

    const { added, duplicates } = dedupeIncomingSongs(incoming, existing)

    expect(added.map((s) => s.id)).toEqual(["fresh-2"])
    expect(duplicates.map((s) => s.id)).toEqual(["fresh-1"])
  })

  it("collapses repeats within the incoming batch itself", () => {
    const incoming = [song("1", "Grace"), song("2", "Grace"), song("3", "Grace")]

    const { added, duplicates } = dedupeIncomingSongs(incoming, [])

    expect(added.map((s) => s.id)).toEqual(["1"])
    expect(duplicates.map((s) => s.id)).toEqual(["2", "3"])
  })

  it("preserves incoming order and returns the original objects untouched", () => {
    const incoming = [song("1", "Charlie"), song("2", "Alpha"), song("3", "Bravo")]

    const { added } = dedupeIncomingSongs(incoming, [])

    expect(added).toEqual(incoming)
    expect(added[0]).toBe(incoming[0])
  })

  it("does not mutate either argument", () => {
    const existing = [song("a", "Grace")]
    const incoming = [song("b", "Grace"), song("c", "Peace")]

    dedupeIncomingSongs(incoming, existing)

    expect(existing).toHaveLength(1)
    expect(incoming.map((s) => s.id)).toEqual(["b", "c"])
  })

  it("returns empty results for an empty import", () => {
    expect(dedupeIncomingSongs([], [song("a", "Grace")])).toEqual({ added: [], duplicates: [] })
  })
})
