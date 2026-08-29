import { create } from "zustand"
import { toast } from "sonner"
import { pickVideoFile } from "@/lib/media/media-files"
import {
  clearPresentation,
  presentVideo,
  usePresentationOnAir,
} from "@/lib/presentation-broadcast"

/**
 * Media loops module (fork-owned): EasyWorship-mini-movie-style looping
 * videos for pre-service announcements. Session-only — the operator picks
 * video files each session; nothing is persisted and nothing is copied,
 * the file streams from its on-disk path via the asset protocol.
 */
export interface MediaLoopItem {
  id: string
  /** Basename shown in the row, e.g. "announcement-loop.mp4". */
  name: string
  /** Absolute on-disk path (kept for reference; not re-read). */
  path: string
  /** Streamable asset-protocol URL passed to presentVideo(). */
  src: string
  /** Loop playback; announcement loops default to looping. */
  loop: boolean
  /** Playback volume 0..1; announcement loops default to silent. */
  volume: number
}

interface MediaState {
  items: MediaLoopItem[]
  /** ID of the item currently on air, or null if nothing is playing. */
  playingId: string | null
  /** Playing item is holding its current frame (still owns the output). */
  paused: boolean

  /** Opens the file picker and adds the chosen video to the list. */
  addItem: () => Promise<void>
  removeItem: (id: string) => void
  updateItem: (id: string, patch: Partial<Pick<MediaLoopItem, "loop" | "volume">>) => void
  /** Presents the item's video on all outputs and marks it as on air. */
  play: (id: string) => void
  /** Pause holds the frame and KEEPS the channel (still supersedes
   * verses/slides); resume continues from the same position. */
  togglePause: () => void
  /** Clears the output and marks nothing as on air. A later play() starts
   * from the beginning — stop releases the channel entirely. */
  stop: () => void
}

export const useMediaStore = create<MediaState>((set, get) => ({
  items: [],
  playingId: null,
  paused: false,

  addItem: async () => {
    try {
      const picked = await pickVideoFile()
      if (!picked) return

      const item: MediaLoopItem = {
        id: crypto.randomUUID(),
        name: picked.name,
        path: picked.path,
        src: picked.src,
        loop: true,
        volume: 0,
      }
      set((state) => ({ items: [...state.items, item] }))
    } catch (error) {
      toast.error("Could not add video", { description: String(error) })
    }
  },

  removeItem: (id) => {
    if (get().playingId === id) {
      clearPresentation()
    }
    set((state) => ({
      items: state.items.filter((i) => i.id !== id),
      playingId: state.playingId === id ? null : state.playingId,
    }))
  },

  updateItem: (id, patch) => {
    set((state) => ({
      items: state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }))
    // If the item being edited is currently on air, re-present it with the
    // new options so loop/volume changes take effect immediately.
    const state = get()
    if (state.playingId === id) {
      const item = state.items.find((i) => i.id === id)
      if (item) {
        presentVideo(item.src, {
          loop: item.loop,
          volume: item.volume,
          paused: state.paused,
        })
      }
    }
  },

  play: (id) => {
    const item = get().items.find((i) => i.id === id)
    if (!item) return
    presentVideo(item.src, { loop: item.loop, volume: item.volume, paused: false })
    set({ playingId: id, paused: false })
  },

  togglePause: () => {
    const { playingId, paused, items } = get()
    const item = items.find((i) => i.id === playingId)
    if (!item) return
    const next = !paused
    presentVideo(item.src, { loop: item.loop, volume: item.volume, paused: next })
    set({ paused: next })
  },

  stop: () => {
    clearPresentation()
    set({ playingId: null, paused: false })
  },
}))

// Keep playingId in sync with reality: another module (slides, or a verse
// cue interrupting via presentation-broadcast's own broadcast-store
// subscription) can displace our video at any time — reset the "on air"
// row so the panel doesn't show a stale LIVE badge.
usePresentationOnAir.subscribe((state, prev) => {
  if (state.onAir === prev.onAir) return
  if (useMediaStore.getState().playingId === null) return
  if (!state.onAir || state.onAir.kind !== "video") {
    useMediaStore.setState({ playingId: null, paused: false })
  }
})
