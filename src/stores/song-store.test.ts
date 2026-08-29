import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Song, SongSection } from "@/types/songs"

const setLiveVerseMock = vi.fn()

vi.mock("@/stores/broadcast-store", () => ({
  useBroadcastStore: {
    getState: () => ({ setLiveVerse: setLiveVerseMock }),
  },
}))

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockSave = vi.fn()
const mockLoad = vi.fn()

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => mockLoad(...args),
}))

vi.mock("@/lib/songs/sample-song", () => ({
  SAMPLE_SONG: {
    id: "sample-song-id",
    title: "Amazing Grace",
    artist: "John Newton",
    sections: [{ id: "s1", label: "Verse 1", lines: ["Amazing grace"] }],
    arrangement: [],
    createdAt: 0,
    updatedAt: 0,
  } satisfies Song,
}))

function makeSection(overrides: Partial<SongSection> = {}): SongSection {
  return { id: crypto.randomUUID(), label: "Verse 1", lines: ["line a", "line b"], ...overrides }
}

function makeSong(overrides: Partial<Song> = {}): Song {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: "My Song",
    artist: "Someone",
    sections: [],
    arrangement: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function flushSave(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600)
  await Promise.resolve()
  await Promise.resolve()
}

describe("song store catalog CRUD", () => {
  beforeEach(async () => {
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  it("addSong assigns id/createdAt/updatedAt and appends to the catalog", async () => {
    const { useSongStore } = await import("./song-store")
    const created = useSongStore.getState().addSong({
      title: "New Song",
      artist: "Artist",
      sections: [],
      arrangement: [],
    })

    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBeTypeOf("number")
    expect(useSongStore.getState().songs).toHaveLength(1)
    expect(useSongStore.getState().songs[0]).toEqual(created)
  })

  it("updateSong merges a patch and bumps updatedAt without changing id", async () => {
    const { useSongStore } = await import("./song-store")
    const created = useSongStore.getState().addSong({
      title: "Old Title",
      artist: "",
      sections: [],
      arrangement: [],
    })

    useSongStore.getState().updateSong(created.id, { title: "New Title" })

    const updated = useSongStore.getState().songs[0]
    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe("New Title")
  })

  it("importSongs appends without touching existing songs", async () => {
    const { useSongStore } = await import("./song-store")
    const existing = useSongStore.getState().addSong({ title: "Existing", artist: "", sections: [], arrangement: [] })
    const incoming = makeSong({ title: "Imported" })

    useSongStore.getState().importSongs([incoming])

    const songs = useSongStore.getState().songs
    expect(songs).toHaveLength(2)
    expect(songs[0]).toEqual(existing)
    expect(songs[1]).toEqual(incoming)
  })

  it("deleteSong removes the song from the catalog", async () => {
    const { useSongStore } = await import("./song-store")
    const created = useSongStore.getState().addSong({ title: "X", artist: "", sections: [], arrangement: [] })

    useSongStore.getState().deleteSong(created.id)

    expect(useSongStore.getState().songs).toHaveLength(0)
  })

  it("setSearchQuery / matchesSearch filters by title, artist, and lyric text case-insensitively", async () => {
    const { useSongStore, matchesSearch } = await import("./song-store")
    useSongStore.getState().setSearchQuery("grace")
    expect(useSongStore.getState().searchQuery).toBe("grace")

    const song = makeSong({
      title: "Amazing Grace",
      artist: "John Newton",
      sections: [makeSection({ lines: ["how sweet the SOUND"] })],
    })

    expect(matchesSearch(song, "grace")).toBe(true)
    expect(matchesSearch(song, "GRACE")).toBe(true)
    expect(matchesSearch(song, "newton")).toBe(true)
    expect(matchesSearch(song, "sweet the sound")).toBe(true)
    expect(matchesSearch(song, "nonexistent")).toBe(false)
    expect(matchesSearch(song, "")).toBe(true)
  })
})

describe("song store setlist", () => {
  beforeEach(() => {
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  it("addSongToSetlist expands the song's arrangement into blocks on one call", async () => {
    const { useSongStore } = await import("./song-store")
    const v1 = makeSection({ label: "Verse 1", lines: ["a"] })
    const c = makeSection({ label: "Chorus", lines: ["b"] })
    const song = makeSong({ sections: [v1, c], arrangement: [v1.id, c.id, c.id] })
    useSongStore.setState({ songs: [song] })

    useSongStore.getState().addSongToSetlist(song.id)

    const setlist = useSongStore.getState().setlist
    expect(setlist).toHaveLength(1)
    expect(setlist[0].songId).toBe(song.id)
    expect(setlist[0].title).toBe(song.title)
    // v1, then c+c collapsed into one repeat block
    expect(setlist[0].blocks.map((b) => b.label)).toEqual(["Verse 1", "Chorus (x2)"])
  })

  it("addSongToSetlist does nothing for an unknown song id", async () => {
    const { useSongStore } = await import("./song-store")
    useSongStore.getState().addSongToSetlist("missing")
    expect(useSongStore.getState().setlist).toHaveLength(0)
  })

  it("removeEntry removes the entry and clears activeBlockId only if it belonged to that entry", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    useSongStore.getState().presentBlock(entry.id, entry.blocks[0].id)

    useSongStore.getState().removeEntry(entry.id)

    expect(useSongStore.getState().setlist).toHaveLength(0)
    expect(useSongStore.getState().activeBlockId).toBeNull()
  })

  it("clearSetlist empties the setlist and active block", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)

    useSongStore.getState().clearSetlist()

    expect(useSongStore.getState().setlist).toEqual([])
    expect(useSongStore.getState().activeBlockId).toBeNull()
  })

  it("reorderEntries moves an entry to a new index", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({ title: "A", sections: [makeSection()], arrangement: [] })
    const songB = makeSong({ title: "B", sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    useSongStore.getState().addSongToSetlist(songB.id)

    useSongStore.getState().reorderEntries(0, 1)

    expect(useSongStore.getState().setlist.map((e) => e.title)).toEqual(["B", "A"])
  })
})

describe("song store presentation", () => {
  beforeEach(() => {
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  it("presentBlock sets activeBlockId and calls broadcast setLiveVerse with noAutoFade render data", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({
      title: "Amazing Grace",
      sections: [makeSection({ label: "Chorus", lines: ["sing"] })],
      arrangement: [],
    })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    const block = entry.blocks[0]

    useSongStore.getState().presentBlock(entry.id, block.id)

    expect(useSongStore.getState().activeBlockId).toBe(block.id)
    expect(setLiveVerseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "Amazing Grace — Chorus",
        segments: [{ text: "sing" }],
        noAutoFade: true,
      })
    )
  })

  it("presentBlock is a no-op for an unknown entry or block id", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]

    useSongStore.getState().presentBlock("bogus-entry", entry.blocks[0].id)
    useSongStore.getState().presentBlock(entry.id, "bogus-block")

    expect(useSongStore.getState().activeBlockId).toBeNull()
    expect(setLiveVerseMock).not.toHaveBeenCalled()
  })

  it("nextBlock/prevBlock step across the flattened block list, crossing entry boundaries", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({
      title: "Song A",
      sections: [makeSection({ label: "Verse 1", lines: ["a1"] }), makeSection({ label: "Chorus", lines: ["a2"] })],
    })
    songA.arrangement = songA.sections.map((s) => s.id)
    const songB = makeSong({
      title: "Song B",
      sections: [makeSection({ label: "Verse 1", lines: ["b1"] })],
    })
    songB.arrangement = songB.sections.map((s) => s.id)
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    useSongStore.getState().addSongToSetlist(songB.id)

    // Starting with no active block, next() should present the very first block.
    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song A — Verse 1" })
    )

    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song A — Chorus" })
    )

    // Crosses from song A's last block into song B's first block.
    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song B — Verse 1" })
    )

    // Already at the last block overall — clamps, does not throw or wrap.
    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song B — Verse 1" })
    )

    // Step back across the entry boundary.
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song A — Chorus" })
    )

    useSongStore.getState().prevBlock()
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: "Song A — Verse 1" })
    )
  })

  it("nextBlock/prevBlock are no-ops on an empty setlist", async () => {
    const { useSongStore } = await import("./song-store")
    useSongStore.getState().nextBlock()
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).not.toHaveBeenCalled()
    expect(useSongStore.getState().activeBlockId).toBeNull()
  })
})

describe("song store catalog hydration", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGet.mockReset()
    mockSet.mockReset()
    mockSave.mockReset()
    mockLoad.mockReset()
    mockLoad.mockResolvedValue({ get: mockGet, set: mockSet, save: mockSave })
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  it("seeds the catalog with SAMPLE_SONG when the persisted catalog is empty", async () => {
    mockGet.mockResolvedValue(undefined)

    const { hydrateSongCatalog, useSongStore } = await import("./song-store")
    await hydrateSongCatalog()

    expect(useSongStore.getState().songs).toHaveLength(1)
    expect(useSongStore.getState().songs[0].title).toBe("Amazing Grace")
  })

  it("hydrate uses the persisted catalog when non-empty, without seeding the sample", async () => {
    const persisted: Song[] = [makeSong({ title: "Persisted Song" })]
    mockGet.mockResolvedValue(persisted)

    const { hydrateSongCatalog, useSongStore } = await import("./song-store")
    await hydrateSongCatalog()

    expect(useSongStore.getState().songs).toEqual(persisted)
  })

  it("persists the catalog (debounced) after a mutating call post-hydration", async () => {
    mockGet.mockResolvedValue([])

    const { hydrateSongCatalog, useSongStore } = await import("./song-store")
    await hydrateSongCatalog()
    mockSet.mockClear()

    useSongStore.getState().addSong({ title: "Fresh", artist: "", sections: [], arrangement: [] })

    expect(mockSet).not.toHaveBeenCalled()
    await flushSave()
    expect(mockSet).toHaveBeenCalledWith("songs", expect.arrayContaining([expect.objectContaining({ title: "Fresh" })]))
    expect(mockSave).toHaveBeenCalled()
  })

  it("does not persist when the setlist changes (session-only)", async () => {
    mockGet.mockResolvedValue([makeSong({ sections: [makeSection()], arrangement: [] })])

    const { hydrateSongCatalog, useSongStore } = await import("./song-store")
    await hydrateSongCatalog()
    const song = useSongStore.getState().songs[0]
    mockSet.mockClear()

    useSongStore.getState().addSongToSetlist(song.id)
    await flushSave()

    expect(mockSet).not.toHaveBeenCalled()
  })

  it("hydrate handles load rejection by falling back to the sample song", async () => {
    mockLoad.mockRejectedValue(new Error("no store"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { hydrateSongCatalog, useSongStore } = await import("./song-store")
    await expect(hydrateSongCatalog()).resolves.toBeUndefined()

    expect(useSongStore.getState().songs).toHaveLength(1)
    expect(useSongStore.getState().songs[0].title).toBe("Amazing Grace")
    warnSpy.mockRestore()
  })
})
