import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"
import type { Song, SetlistEntry, SongBlock } from "@/types/songs"
import { expandSong } from "@/lib/songs/block-expansion"
import { blockToRenderData } from "@/lib/songs/song-to-render-data"
import { SAMPLE_SONG } from "@/lib/songs/sample-song"
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
  /** Bulk-merge already-fully-formed songs (e.g. from a catalog JSON import) —
   * appends, never overwrites an existing song. */
  importSongs: (songs: Song[]) => void
  setSearchQuery: (query: string) => void

  // Setlist
  addSongToSetlist: (songId: string) => void
  removeEntry: (entryId: string) => void
  clearSetlist: () => void
  reorderEntries: (fromIndex: number, toIndex: number) => void

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

function flattenSetlistBlocks(setlist: SetlistEntry[]): FlatBlockRef[] {
  return setlist.flatMap((entry) => entry.blocks.map((block) => ({ entryId: entry.id, block })))
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
  importSongs: (songs) => set((s) => ({ songs: [...s.songs, ...songs] })),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  addSongToSetlist: (songId) => {
    const song = get().songs.find((s) => s.id === songId)
    if (!song) return
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
      }
    }),
  clearSetlist: () => set({ setlist: [], activeBlockId: null, previewEntryId: null, previewBlockId: null }),
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

  presentBlock: (entryId, blockId) => {
    const entry = get().setlist.find((e) => e.id === entryId)
    const block = entry?.blocks.find((b) => b.id === blockId)
    if (!entry || !block) return
    // Presenting also syncs the preview selection, so Enter/arrow-key
    // browsing continues from whatever just went on air.
    set({ activeBlockId: block.id, previewEntryId: entryId, previewBlockId: block.id })
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
    set({ previewEntryId: entryId, previewBlockId: block.id })
  },
  previewNext: () => {
    const { setlist, previewBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === previewBlockId)
    const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, flat.length - 1)
    const target = flat[nextIndex]
    set({ previewEntryId: target.entryId, previewBlockId: target.block.id })
  },
  previewPrev: () => {
    const { setlist, previewBlockId } = get()
    const flat = flattenSetlistBlocks(setlist)
    if (flat.length === 0) return
    const currentIndex = flat.findIndex((f) => f.block.id === previewBlockId)
    const prevIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0)
    const target = flat[prevIndex]
    set({ previewEntryId: target.entryId, previewBlockId: target.block.id })
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
