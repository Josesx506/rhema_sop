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

  it("deduplicates songs by default: adding the same song twice keeps one entry", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong()
    useSongStore.setState({ songs: [song] })

    useSongStore.getState().addSongToSetlist(song.id)
    useSongStore.getState().addSongToSetlist(song.id)

    expect(useSongStore.getState().setlist).toHaveLength(1)
  })

  it("allows repeated songs when allowSetlistDuplicates is on", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong()
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().setAllowSetlistDuplicates(true)

    useSongStore.getState().addSongToSetlist(song.id)
    useSongStore.getState().addSongToSetlist(song.id)

    const setlist = useSongStore.getState().setlist
    expect(setlist).toHaveLength(2)
    // Distinct entries (unique ids) for the same song.
    expect(setlist[0].id).not.toBe(setlist[1].id)
    expect(setlist[0].songId).toBe(setlist[1].songId)
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

  it("toggleEntryCollapsed flips one entry; setAllEntriesCollapsed covers all", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({ title: "A", sections: [makeSection()], arrangement: [] })
    const songB = makeSong({ title: "B", sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    useSongStore.getState().addSongToSetlist(songB.id)
    const [entryA, entryB] = useSongStore.getState().setlist

    useSongStore.getState().toggleEntryCollapsed(entryA.id)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({ [entryA.id]: true })

    useSongStore.getState().toggleEntryCollapsed(entryA.id)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({})

    useSongStore.getState().setAllEntriesCollapsed(true)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({
      [entryA.id]: true,
      [entryB.id]: true,
    })

    useSongStore.getState().setAllEntriesCollapsed(false)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({})
  })

  it("presenting or previewing into a collapsed entry expands it", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]

    useSongStore.getState().setAllEntriesCollapsed(true)
    useSongStore.getState().presentBlock(entry.id, entry.blocks[0].id)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({})

    useSongStore.getState().setAllEntriesCollapsed(true)
    useSongStore.getState().previewBlock(entry.id, entry.blocks[0].id)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({})
  })

  it("removeEntry and clearSetlist drop collapse state for gone entries", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({ title: "A", sections: [makeSection()], arrangement: [] })
    const songB = makeSong({ title: "B", sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    useSongStore.getState().addSongToSetlist(songB.id)
    const [entryA, entryB] = useSongStore.getState().setlist

    useSongStore.getState().setAllEntriesCollapsed(true)
    useSongStore.getState().removeEntry(entryA.id)
    expect(useSongStore.getState().collapsedEntryIds).toEqual({ [entryB.id]: true })

    useSongStore.getState().clearSetlist()
    expect(useSongStore.getState().collapsedEntryIds).toEqual({})
  })
})

describe("song store loadSetlist", () => {
  beforeEach(() => {
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  function exportOf(songs: Song[]) {
    return {
      format: "rhema-setlist" as const,
      version: 1 as const,
      exportedAt: 0,
      entries: songs.map((s) => ({ songId: s.id, title: s.title, artist: s.artist })),
      songs,
    }
  }

  it("rebuilds the setlist in the saved order and re-expands blocks from the catalog", async () => {
    const { useSongStore } = await import("./song-store")
    const v1 = makeSection({ label: "Verse 1", lines: ["a"] })
    const c = makeSection({ label: "Chorus", lines: ["b"] })
    const first = makeSong({ title: "First", sections: [v1, c], arrangement: [v1.id, c.id] })
    const second = makeSong({ title: "Second", sections: [makeSection()] })
    useSongStore.setState({ songs: [first, second], setlist: [] })

    const result = useSongStore.getState().loadSetlist(exportOf([second, first]))

    expect(result).toEqual({ loaded: 2, added: 0, missing: [] })
    const setlist = useSongStore.getState().setlist
    expect(setlist.map((e) => e.title)).toEqual(["Second", "First"])
    expect(setlist[1].blocks.map((b) => b.label)).toEqual(["Verse 1", "Chorus"])
  })

  it("replaces whatever was in the setlist and resets live/preview/collapse state", async () => {
    const { useSongStore } = await import("./song-store")
    const stale = makeSong({ title: "Stale", sections: [makeSection()] })
    const fresh = makeSong({ title: "Fresh", sections: [makeSection()] })
    useSongStore.setState({ songs: [stale, fresh] })
    useSongStore.getState().addSongToSetlist(stale.id)
    const staleEntry = useSongStore.getState().setlist[0]
    useSongStore.getState().presentBlock(staleEntry.id, staleEntry.blocks[0].id)
    useSongStore.getState().setAllEntriesCollapsed(true)

    useSongStore.getState().loadSetlist(exportOf([fresh]))

    const state = useSongStore.getState()
    expect(state.setlist.map((e) => e.title)).toEqual(["Fresh"])
    expect(state.activeBlockId).toBeNull()
    expect(state.collapsedEntryIds).toEqual({})
    // Preview lands on the first block so the operator can start immediately.
    expect(state.previewEntryId).toBe(state.setlist[0].id)
    expect(state.previewBlockId).toBe(state.setlist[0].blocks[0].id)
  })

  it("adds songs the catalog is missing rather than dropping the entry", async () => {
    const { useSongStore } = await import("./song-store")
    const known = makeSong({ title: "Known", sections: [makeSection()] })
    const unknown = makeSong({ title: "Unknown", sections: [makeSection()] })
    useSongStore.setState({ songs: [known], setlist: [] })

    const result = useSongStore.getState().loadSetlist(exportOf([known, unknown]))

    expect(result.added).toBe(1)
    expect(useSongStore.getState().songs.map((s) => s.title)).toEqual(["Known", "Unknown"])
    expect(useSongStore.getState().setlist.map((e) => e.title)).toEqual(["Known", "Unknown"])
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
        footerLabel: "Amazing Grace",
        segments: [{ text: "sing", breakAfter: true }],
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
      expect.objectContaining({ footerLabel: "Song A", segments: [{ text: "a1", breakAfter: true }] })
    )

    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ footerLabel: "Song A", segments: [{ text: "a2", breakAfter: true }] })
    )

    // Crosses from song A's last block into song B's first block.
    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ footerLabel: "Song B", segments: [{ text: "b1", breakAfter: true }] })
    )

    // Already at the last block overall — clamps, does not throw or wrap.
    useSongStore.getState().nextBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ footerLabel: "Song B", segments: [{ text: "b1", breakAfter: true }] })
    )

    // Step back across the entry boundary.
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ footerLabel: "Song A", segments: [{ text: "a2", breakAfter: true }] })
    )

    useSongStore.getState().prevBlock()
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ footerLabel: "Song A", segments: [{ text: "a1", breakAfter: true }] })
    )
  })

  it("nextBlock/prevBlock are no-ops on an empty setlist", async () => {
    const { useSongStore } = await import("./song-store")
    useSongStore.getState().nextBlock()
    useSongStore.getState().prevBlock()
    expect(setLiveVerseMock).not.toHaveBeenCalled()
    expect(useSongStore.getState().activeBlockId).toBeNull()
  })

  it("presentBlock syncs the preview selection to the presented block", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection({ label: "Chorus" })], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    const block = entry.blocks[0]

    useSongStore.getState().presentBlock(entry.id, block.id)

    expect(useSongStore.getState().previewEntryId).toBe(entry.id)
    expect(useSongStore.getState().previewBlockId).toBe(block.id)
  })
})

describe("song store preview selection", () => {
  beforeEach(() => {
    vi.resetModules()
    setLiveVerseMock.mockReset()
  })

  it("addSongToSetlist previews the first block of the newly added song when nothing is previewed yet", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection({ label: "Verse 1" })], arrangement: [] })
    useSongStore.setState({ songs: [song] })

    useSongStore.getState().addSongToSetlist(song.id)

    const entry = useSongStore.getState().setlist[0]
    expect(useSongStore.getState().previewEntryId).toBe(entry.id)
    expect(useSongStore.getState().previewBlockId).toBe(entry.blocks[0].id)
    // Adding to the setlist must never touch the live output.
    expect(setLiveVerseMock).not.toHaveBeenCalled()
  })

  it("addSongToSetlist does not disturb an existing preview selection", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({ title: "A", sections: [makeSection({ label: "Verse 1" })], arrangement: [] })
    const songB = makeSong({ title: "B", sections: [makeSection({ label: "Verse 1" })], arrangement: [] })
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    const entryA = useSongStore.getState().setlist[0]
    const chosenBlock = entryA.blocks[0]
    useSongStore.getState().previewBlock(entryA.id, chosenBlock.id)

    useSongStore.getState().addSongToSetlist(songB.id)

    expect(useSongStore.getState().previewEntryId).toBe(entryA.id)
    expect(useSongStore.getState().previewBlockId).toBe(chosenBlock.id)
  })

  it("previewBlock sets the preview ids without touching activeBlockId or calling setLiveVerse", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection({ label: "Chorus" })], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    const block = entry.blocks[0]

    useSongStore.getState().previewBlock(entry.id, block.id)

    expect(useSongStore.getState().previewEntryId).toBe(entry.id)
    expect(useSongStore.getState().previewBlockId).toBe(block.id)
    expect(useSongStore.getState().activeBlockId).toBeNull()
    expect(setLiveVerseMock).not.toHaveBeenCalled()
  })

  it("previewBlock is a no-op for an unknown entry or block id", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    // Clear the auto-preview from addSongToSetlist so we can assert the no-op cleanly.
    useSongStore.setState({ previewEntryId: null, previewBlockId: null })
    const entry = useSongStore.getState().setlist[0]

    useSongStore.getState().previewBlock("bogus-entry", entry.blocks[0].id)
    useSongStore.getState().previewBlock(entry.id, "bogus-block")

    expect(useSongStore.getState().previewEntryId).toBeNull()
    expect(useSongStore.getState().previewBlockId).toBeNull()
  })

  it("previewNext/previewPrev step across the flattened block list without presenting", async () => {
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
    const [entryA, entryB] = useSongStore.getState().setlist

    // addSongToSetlist already previewed Song A's first block.
    expect(useSongStore.getState().previewBlockId).toBe(entryA.blocks[0].id)

    useSongStore.getState().previewNext()
    expect(useSongStore.getState().previewEntryId).toBe(entryA.id)
    expect(useSongStore.getState().previewBlockId).toBe(entryA.blocks[1].id)

    // Crosses from song A's last block into song B's first block.
    useSongStore.getState().previewNext()
    expect(useSongStore.getState().previewEntryId).toBe(entryB.id)
    expect(useSongStore.getState().previewBlockId).toBe(entryB.blocks[0].id)

    // Already at the last block overall — clamps, does not wrap.
    useSongStore.getState().previewNext()
    expect(useSongStore.getState().previewBlockId).toBe(entryB.blocks[0].id)

    useSongStore.getState().previewPrev()
    expect(useSongStore.getState().previewEntryId).toBe(entryA.id)
    expect(useSongStore.getState().previewBlockId).toBe(entryA.blocks[1].id)

    useSongStore.getState().previewPrev()
    useSongStore.getState().previewPrev()
    expect(useSongStore.getState().previewBlockId).toBe(entryA.blocks[0].id)

    // Never touches the live output.
    expect(setLiveVerseMock).not.toHaveBeenCalled()
  })

  it("previewNext/previewPrev are no-ops on an empty setlist", async () => {
    const { useSongStore } = await import("./song-store")
    useSongStore.getState().previewNext()
    useSongStore.getState().previewPrev()
    expect(useSongStore.getState().previewEntryId).toBeNull()
    expect(useSongStore.getState().previewBlockId).toBeNull()
  })

  it("presentPreviewed presents whatever block is currently previewed", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({
      title: "Song A",
      sections: [makeSection({ label: "Verse 1" }), makeSection({ label: "Chorus" })],
    })
    song.arrangement = song.sections.map((s) => s.id)
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    useSongStore.getState().previewBlock(entry.id, entry.blocks[1].id)

    useSongStore.getState().presentPreviewed()

    expect(useSongStore.getState().activeBlockId).toBe(entry.blocks[1].id)
    expect(setLiveVerseMock).toHaveBeenCalledWith(
      expect.objectContaining({ footerLabel: "Song A", segments: [{ text: "line a", breakAfter: true }, { text: "line b", breakAfter: true }] })
    )
  })

  it("presentPreviewed is a no-op when nothing is previewed", async () => {
    const { useSongStore } = await import("./song-store")
    useSongStore.getState().presentPreviewed()
    expect(setLiveVerseMock).not.toHaveBeenCalled()
    expect(useSongStore.getState().activeBlockId).toBeNull()
  })

  it("removeEntry clears a dangling preview selection that belonged to the removed entry", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)
    const entry = useSongStore.getState().setlist[0]
    expect(useSongStore.getState().previewBlockId).toBe(entry.blocks[0].id)

    useSongStore.getState().removeEntry(entry.id)

    expect(useSongStore.getState().previewEntryId).toBeNull()
    expect(useSongStore.getState().previewBlockId).toBeNull()
  })

  it("removeEntry leaves an unrelated preview selection untouched", async () => {
    const { useSongStore } = await import("./song-store")
    const songA = makeSong({ title: "A", sections: [makeSection()], arrangement: [] })
    const songB = makeSong({ title: "B", sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [songA, songB] })
    useSongStore.getState().addSongToSetlist(songA.id)
    useSongStore.getState().addSongToSetlist(songB.id)
    const [entryA, entryB] = useSongStore.getState().setlist
    // Preview selection defaulted to entry A's first block; keep it there.
    expect(useSongStore.getState().previewEntryId).toBe(entryA.id)

    useSongStore.getState().removeEntry(entryB.id)

    expect(useSongStore.getState().previewEntryId).toBe(entryA.id)
    expect(useSongStore.getState().previewBlockId).toBe(entryA.blocks[0].id)
  })

  it("clearSetlist clears the preview selection along with the setlist", async () => {
    const { useSongStore } = await import("./song-store")
    const song = makeSong({ sections: [makeSection()], arrangement: [] })
    useSongStore.setState({ songs: [song] })
    useSongStore.getState().addSongToSetlist(song.id)

    useSongStore.getState().clearSetlist()

    expect(useSongStore.getState().previewEntryId).toBeNull()
    expect(useSongStore.getState().previewBlockId).toBeNull()
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
