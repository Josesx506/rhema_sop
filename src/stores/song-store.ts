import { create } from "zustand"
import { toast } from "sonner"
import { load, type Store } from "@tauri-apps/plugin-store"
import type { Song, SetlistEntry, SongBlock } from "@/types/songs"
import { expandSong } from "@/lib/songs/block-expansion"
import { blockToRenderData } from "@/lib/songs/song-to-render-data"
import { SAMPLE_SONG } from "@/lib/songs/sample-song"
import { resolveSetlist, type SetlistExport } from "@/lib/songs/setlist-file"
import { dedupeIncomingSongs } from "@/lib/songs/song-dedupe"
import { useBroadcastStore } from "@/stores/broadcast-store"

interface FlatBlockRef {
  entryId: string
  block: SongBlock
}

interface SongState {
  // Catalog (persisted)
  songs: Song[]
  searchQuery: string

  // Setlist (session-only, never persisted)
  setlist: SetlistEntry[]
  activeBlockId: string | null

  // Preview selection (session-only, never persisted). Independent of what's
  // live — operators browse the preview before committing it to air.
  previewEntryId: string | null
  previewBlockId: string | null

  // Catalog CRUD
  addSong: (input: Omit<Song, "id" | "createdAt" | "updatedAt">) => Song
  updateSong: (id: string, patch: Partial<Omit<Song, "id">>) => void
  deleteSong: (id: string) => void
  /** Bulk-merge already-fully-formed songs (e.g. from a catalog JSON import).
   * Appends, never overwrites; songs already in the catalog (by title +
   * artist, see songIdentityKey) and repeats within the batch are dropped.
   * Returns a summary for the operator toast. */
  importSongs: (songs: Song[]) => { added: number; duplicates: number }
  setSearchQuery: (query: string) => void
  /** Catalog list order (session-only). Alphabetical by default: insertion
   * order buried every import at the bottom of a few hundred songs. */
  catalogSort: CatalogSort
  setCatalogSort: (sort: CatalogSort) => void

  // Setlist
  addSongToSetlist: (songId: string) => void
  removeEntry: (entryId: string) => void
  clearSetlist: () => void
  reorderEntries: (fromIndex: number, toIndex: number) => void
  /** Replace the setlist with a saved one, adding any songs the catalog is
   * missing. Returns a summary for the operator toast. */
  loadSetlist: (payload: SetlistExport) => { loaded: number; added: number; missing: string[] }
  /** When false (default), adding a song already in the setlist is a no-op
   * — one entry per song. Toggle on for playlists that repeat a song. */
  allowSetlistDuplicates: boolean
  setAllowSetlistDuplicates: (allow: boolean) => void

  /** Entry ids whose block list is hidden in the setlist panel
   * (session-only). Purely visual: presentation and arrow-key order still
   * cover every block; presenting or previewing into a collapsed entry
   * expands it so the on-air row stays visible. */
  collapsedEntryIds: Record<string, true>
  toggleEntryCollapsed: (entryId: string) => void
  setAllEntriesCollapsed: (collapsed: boolean) => void

  // Presentation
  presentBlock: (entryId: string, blockId: string) => void
  nextBlock: () => void
  prevBlock: () => void

  // Preview
  previewBlock: (entryId: string, blockId: string) => void
  previewNext: () => void
  previewPrev: () => void
  presentPreviewed: () => void
}

/** Case-insensitive match on title, artist, or any lyric line. */
export function matchesSearch(song: Song, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (song.title.toLowerCase().includes(q)) return true
  if (song.artist.toLowerCase().includes(q)) return true
  return song.sections.some((section) => section.lines.some((line) => line.toLowerCase().includes(q)))
}

/**
 * Alphabetical catalog order. Locale-aware and case-insensitive, numeric so
 * "Psalm 2" precedes "Psalm 10", with artist as a stable tiebreak for
 * same-named songs. Leading articles are deliberately not stripped — "The
 * Solid Rock" filing under S would surprise anyone scrolling for it.
 */
export function compareSongsByTitle(a: Song, b: Song): number {
  const byTitle = a.title.localeCompare(b.title, undefined, {
    sensitivity: "base",
    numeric: true,
  })
  if (byTitle !== 0) return byTitle
  return a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" })
}

/** Newest first — what you want right after adding or importing songs. */
export function compareSongsByRecent(a: Song, b: Song): number {
  return b.createdAt - a.createdAt || compareSongsByTitle(a, b)
}

/** Order the catalog list is displayed in. Session-only: a sort preference
 * is a "right now" choice, not something to restore three weeks later. */
export type CatalogSort = "title" | "recent"

export function sortCatalog(songs: Song[], sort: CatalogSort): Song[] {
  return songs.sort(sort === "recent" ? compareSongsByRecent : compareSongsByTitle)
}

function flattenSetlistBlocks(setlist: SetlistEntry[]): FlatBlockRef[] {
  return setlist.flatMap((entry) => entry.blocks.map((block) => ({ entryId: entry.id, block })))
}

/** Returns the map without entryId — or the same reference when absent. */
function withoutCollapsed(
  collapsed: Record<string, true>,
  entryId: string
): Record<string, true> {
  if (!collapsed[entryId]) return collapsed
  const next = { ...collapsed }
  delete next[entryId]
  return next
}

export const useSongStore = create<SongState>((set, get) => ({
  songs: [],
  searchQuery: "",
  setlist: [],
  activeBlockId: null,
  previewEntryId: null,
  previewBlockId: null,

  addSong: (input) => {
    const now = Date.now()
    const song: Song = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
    set((s) => ({ songs: [...s.songs, song] }))
    return song
  },
  updateSong: (id, patch) =>
    set((s) => ({
      songs: s.songs.map((song) => (song.id === id ? { ...song, ...patch, id, updatedAt: Date.now() } : song)),
    })),
  deleteSong: (id) => set((s) => ({ songs: s.songs.filter((song) => song.id !== id) })),
  importSongs: (songs) => {
    let summary = { added: 0, duplicates: 0 }
    set((s) => {
      const { added, duplicates } = dedupeIncomingSongs(songs, s.songs)
      summary = { added: added.length, duplicates: duplicates.length }
      return added.length > 0 ? { songs: [...s.songs, ...added] } : {}
    })
    return summary
  },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  catalogSort: "title",
  setCatalogSort: (catalogSort) => set({ catalogSort }),

  allowSetlistDuplicates: false,
  setAllowSetlistDuplicates: (allowSetlistDuplicates) => set({ allowSetlistDuplicates }),

  collapsedEntryIds: {},
  toggleEntryCollapsed: (entryId) =>
    set((s) => ({
      collapsedEntryIds: s.collapsedEntryIds[entryId]
        ? withoutCollapsed(s.collapsedEntryIds, entryId)
        : { ...s.collapsedEntryIds, [entryId]: true },
    })),
  setAllEntriesCollapsed: (collapsed) =>
    set((s) => ({
      collapsedEntryIds: collapsed
        ? Object.fromEntries(s.setlist.map((e) => [e.id, true]))
        : {},
    })),

  addSongToSetlist: (songId) => {
    const song = get().songs.find((s) => s.id === songId)
    if (!song) return
    if (
      !get().allowSetlistDuplicates &&
      get().setlist.some((e) => e.songId === songId)
    ) {
      toast.info(`"${song.title}" is already in the setlist`, {
        description: "Turn on Repeats in the setlist header to add it again.",
      })
      return
    }
    const entry: SetlistEntry = {
      id: crypto.randomUUID(),
      songId: song.id,
      title: song.title,
      blocks: expandSong(song),
    }
    set((s) => {
      // Give the operator something to look at right away: if nothing is
      // previewed yet, default the preview to this song's first block.
      const shouldPreviewFirst = s.previewBlockId === null && entry.blocks.length > 0
      return {
        setlist: [...s.setlist, entry],
        ...(shouldPreviewFirst
          ? { previewEntryId: entry.id, previewBlockId: entry.blocks[0].id }
          : {}),
      }
    })
  },
  removeEntry: (entryId) =>
    set((s) => {
      const removed = s.setlist.find((e) => e.id === entryId)
      const activeWasInRemoved = removed?.blocks.some((b) => b.id === s.activeBlockId) ?? false
      const previewWasInRemoved = s.previewEntryId === entryId
      return {
        setlist: s.setlist.filter((e) => e.id !== entryId),
        activeBlockId: activeWasInRemoved ? null : s.activeBlockId,
        previewEntryId: previewWasInRemoved ? null : s.previewEntryId,
        previewBlockId: previewWasInRemoved ? null : s.previewBlockId,
        collapsedEntryIds: withoutCollapsed(s.collapsedEntryIds, entryId),
      }
    }),
  clearSetlist: () =>
    set({
      setlist: [],
      activeBlockId: null,
      previewEntryId: null,
      previewBlockId: null,
      collapsedEntryIds: {},
    }),
  reorderEntries: (fromIndex, toIndex) =>
    set((s) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= s.setlist.length ||
        toIndex >= s.setlist.length
      ) {
        return s
      }
      const next = [...s.setlist]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return { setlist: next }
    }),

  loadSetlist: (payload) => {
    const { songs, added, missing } = resolveSetlist(payload, get().songs)
    const entries: SetlistEntry[] = songs.map((song) => ({
      id: crypto.randomUUID(),
      songId: song.id,
      title: song.title,
      // Blocks are re-expanded rather than restored from the file, so a song
      // edited since the setlist was saved presents its current arrangement.
      blocks: expandSong(song),
    }))
    set((s) => ({
      songs: added.length > 0 ? [...s.songs, ...added] : s.songs,
      setlist: entries,
      activeBlockId: null,
      collapsedEntryIds: {},
      previewEntryId: entries[0]?.id ?? null,
      previewBlockId: entries[0]?.blocks[0]?.id ?? null,
    }))
    return { loaded: entries.length, added: added.length, missing }
  },

  presentBlock: (entryId, blockId) => {
    const entry = get().setlist.find((e) => e.id === entryId)
    const block = entry?.blocks.find((b) => b.id === blockId)
    if (!entry || !block) return
    // Presenting also syncs the preview selection, so Enter/arrow-key
    // browsing continues from whatever just went on air.
    set((s) => ({
      activeBlockId: block.id,
      previewEntryId: entryId,
      previewBlockId: block.id,
      collapsedEntryIds: withoutCollapsed(s.collapsedEntryIds, entryId),
    }))
    useBroadcastStore.getState().setLiveVerse(blockToRenderData(entry.title, block))
  },
  nextBlock: () => {
    const { setlist, activeBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === activeBlockId)
    const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, flat.length - 1)
    const target = flat[nextIndex]
    get().presentBlock(target.entryId, target.block.id)
  },
  prevBlock: () => {
    const { setlist, activeBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === activeBlockId)
    const prevIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0)
    const target = flat[prevIndex]
    get().presentBlock(target.entryId, target.block.id)
  },

  previewBlock: (entryId, blockId) => {
    const entry = get().setlist.find((e) => e.id === entryId)
    const block = entry?.blocks.find((b) => b.id === blockId)
    if (!entry || !block) return
    set((s) => ({
      previewEntryId: entryId,
      previewBlockId: block.id,
      collapsedEntryIds: withoutCollapsed(s.collapsedEntryIds, entryId),
    }))
  },
  previewNext: () => {
    const { setlist, previewBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === previewBlockId)
    const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, flat.length - 1)
    const target = flat[nextIndex]
    get().previewBlock(target.entryId, target.block.id)
  },
  previewPrev: () => {
    const { setlist, previewBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === previewBlockId)
    const prevIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0)
    const target = flat[prevIndex]
    get().previewBlock(target.entryId, target.block.id)
  },
  presentPreviewed: () => {
    const { previewEntryId, previewBlockId } = get()
    if (!previewEntryId || !previewBlockId) return
    get().presentBlock(previewEntryId, previewBlockId)
  },
}))

// ── Catalog persistence via tauri-plugin-store ──

let tauriStore: Store | null = null
let hydrationPromise: Promise<void> | null = null

async function getSongStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load("songs.json", { autoSave: false, defaults: {} })
  }
  return tauriStore
}

/** Loads the persisted catalog into the store, seeding it with the sample
 * song on first run (empty/missing catalog). Idempotent and safe against
 * concurrent callers. */
export function hydrateSongCatalog(): Promise<void> {
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const store = await getSongStore()
      const songs = (await store.get("songs")) as Song[] | undefined
      useSongStore.setState({ songs: songs && Array.isArray(songs) && songs.length > 0 ? songs : [SAMPLE_SONG] })

      // Auto-persist on catalog changes (debounced). The setlist is
      // session-only and intentionally excluded.
      useSongStore.subscribe((state, prevState) => {
        if (state.songs === prevState.songs) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          pendingSave = pendingSave.then(() => persistSongCatalog(useSongStore.getState().songs))
        }, SAVE_DEBOUNCE_MS)
      })
    } catch {
      console.warn("[songs] Failed to load persisted catalog, using defaults")
      if (useSongStore.getState().songs.length === 0) {
        useSongStore.setState({ songs: [SAMPLE_SONG] })
      }
    }
  })()
  return hydrationPromise
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Promise<void> = Promise.resolve()
const SAVE_DEBOUNCE_MS = 500

async function persistSongCatalog(songs: Song[]): Promise<void> {
  try {
    const store = await getSongStore()
    await store.set("songs", songs)
    await store.save()
  } catch {
    console.warn("[songs] Failed to persist catalog")
  }
}
