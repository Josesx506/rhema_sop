import { create } from "zustand"
import { toast } from "sonner"
import {
  clearPresentation,
  presentSlide,
  usePresentationOnAir,
} from "@/lib/presentation-broadcast"
import { importPdfDeck } from "@/lib/slides/pdf-import"

export interface SlideDeck {
  id: string
  name: string
  pages: string[]
  /** Auto-advance interval in milliseconds. */
  intervalMs: number
  /** Loop back to page 1 after the last page. */
  loop: boolean
}

const DEFAULT_INTERVAL_MS = 8000

interface SlideState {
  decks: SlideDeck[]

  activeDeckId: string | null
  activePageIndex: number
  /** Whether the auto-advance loop is currently running. */
  playing: boolean

  /** Deck/page currently shown in the preview panel — independent of what's
   * live. Presenting a page (live) also updates this to match. */
  previewDeckId: string | null
  previewPageIndex: number

  /** PDF import lifecycle, owned by the store (not a component) so it keeps
   * running/reporting progress across tab switches that unmount the panel. */
  importing: boolean
  importProgress: { done: number; total: number } | null

  addDeck: (deck: { name: string; pages: string[] }) => SlideDeck
  removeDeck: (id: string) => void
  updateDeckSettings: (
    id: string,
    settings: Partial<Pick<SlideDeck, "intervalMs" | "loop">>
  ) => void

  importDeck: () => Promise<void>

  /** Preview a page without touching the live output. */
  previewPage: (deckId: string, index: number) => void
  /** Move the preview within the previewed deck, clamped at the edges. */
  previewNext: () => void
  previewPrev: () => void
  /** Send the currently previewed page live. */
  presentPreviewed: () => void

  presentPage: (deckId: string, index: number) => void
  nextPage: () => void
  prevPage: () => void

  startLoop: (deckId: string, fromIndex?: number) => void
  pauseLoop: () => void
  stopPresenting: () => void
}

let loopTimer: ReturnType<typeof setInterval> | null = null

function clearLoopTimer(): void {
  if (loopTimer !== null) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}

export const useSlideStore = create<SlideState>((set, get) => ({
  decks: [],

  activeDeckId: null,
  activePageIndex: 0,
  playing: false,

  previewDeckId: null,
  previewPageIndex: 0,

  importing: false,
  importProgress: null,

  addDeck: (deck) => {
    const newDeck: SlideDeck = {
      id: crypto.randomUUID(),
      name: deck.name,
      pages: deck.pages,
      intervalMs: DEFAULT_INTERVAL_MS,
      loop: true,
    }
    set((state) => ({ decks: [...state.decks, newDeck] }))
    return newDeck
  },

  removeDeck: (id) => {
    const { activeDeckId, previewDeckId } = get()
    set((state) => ({ decks: state.decks.filter((d) => d.id !== id) }))
    if (activeDeckId === id) {
      get().stopPresenting()
    }
    if (previewDeckId === id) {
      set({ previewDeckId: null, previewPageIndex: 0 })
    }
  },

  updateDeckSettings: (id, settings) =>
    set((state) => ({
      decks: state.decks.map((d) => (d.id === id ? { ...d, ...settings } : d)),
    })),

  importDeck: async () => {
    if (get().importing) {
      toast.info("An import is already in progress")
      return
    }

    set({ importing: true, importProgress: null })
    try {
      const result = await importPdfDeck((done, total) => {
        set({ importProgress: { done, total } })
      })
      if (!result) return // user cancelled the dialog

      const deck = get().addDeck(result)
      toast.success(`Imported "${deck.name}" (${deck.pages.length} slides)`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import PDF")
    } finally {
      set({ importing: false, importProgress: null })
    }
  },

  previewPage: (deckId, index) => {
    const deck = get().decks.find((d) => d.id === deckId)
    if (!deck || deck.pages.length === 0) return
    const clamped = Math.max(0, Math.min(index, deck.pages.length - 1))
    set({ previewDeckId: deckId, previewPageIndex: clamped })
  },

  previewNext: () => {
    const { previewDeckId, previewPageIndex, decks } = get()
    if (!previewDeckId) return
    const deck = decks.find((d) => d.id === previewDeckId)
    if (!deck || deck.pages.length === 0) return
    const next = Math.min(previewPageIndex + 1, deck.pages.length - 1)
    set({ previewPageIndex: next })
  },

  previewPrev: () => {
    const { previewDeckId, previewPageIndex } = get()
    if (!previewDeckId) return
    const prev = Math.max(previewPageIndex - 1, 0)
    set({ previewPageIndex: prev })
  },

  presentPreviewed: () => {
    const { previewDeckId, previewPageIndex } = get()
    if (!previewDeckId) return
    get().presentPage(previewDeckId, previewPageIndex)
  },

  presentPage: (deckId, index) => {
    const deck = get().decks.find((d) => d.id === deckId)
    if (!deck || deck.pages.length === 0) return
    const clamped = Math.max(0, Math.min(index, deck.pages.length - 1))
    set({
      activeDeckId: deckId,
      activePageIndex: clamped,
      // Presenting live also moves the preview selection to match, so the
      // preview panel never shows a stale page once the operator has gone
      // live from it (or from auto-advance).
      previewDeckId: deckId,
      previewPageIndex: clamped,
    })
    presentSlide(deck.pages[clamped])

    // Manually jumping to a slide while the loop is running re-bases the
    // timer, so auto-advance continues intervalMs from the jump rather than
    // from whenever the previous slide happened to go on air.
    if (get().playing) {
      clearLoopTimer()
      loopTimer = setInterval(() => {
        get().nextPage()
      }, deck.intervalMs)
    }
  },

  nextPage: () => {
    const { activeDeckId, activePageIndex, decks } = get()
    if (!activeDeckId) return
    const deck = decks.find((d) => d.id === activeDeckId)
    if (!deck || deck.pages.length === 0) return

    let next = activePageIndex + 1
    if (next >= deck.pages.length) {
      if (!deck.loop) return
      next = 0
    }
    get().presentPage(activeDeckId, next)
  },

  prevPage: () => {
    const { activeDeckId, activePageIndex, decks } = get()
    if (!activeDeckId) return
    const deck = decks.find((d) => d.id === activeDeckId)
    if (!deck || deck.pages.length === 0) return

    let prev = activePageIndex - 1
    if (prev < 0) {
      if (!deck.loop) return
      prev = deck.pages.length - 1
    }
    get().presentPage(activeDeckId, prev)
  },

  startLoop: (deckId, fromIndex = 0) => {
    const deck = get().decks.find((d) => d.id === deckId)
    if (!deck || deck.pages.length === 0) return

    clearLoopTimer()
    set({ playing: true })
    // presentPage sees playing=true and sets up the interval itself.
    get().presentPage(deckId, fromIndex)
  },

  pauseLoop: () => {
    clearLoopTimer()
    set({ playing: false })
  },

  stopPresenting: () => {
    clearLoopTimer()
    set({ playing: false, activeDeckId: null, activePageIndex: 0 })
    clearPresentation()
  },
}))

// Something else took over the output — a verse was presented (onAir goes
// null) or a media loop started (onAir becomes a video payload). Stop our
// timer and reset so the panel matches what's actually on air; without
// this the interval would keep re-presenting slides over the video.
usePresentationOnAir.subscribe((state, prev) => {
  if (state.onAir === prev.onAir) return
  if (state.onAir?.kind === "slide") return
  const { activeDeckId, playing } = useSlideStore.getState()
  if (activeDeckId !== null || playing) {
    clearLoopTimer()
    useSlideStore.setState({ playing: false, activeDeckId: null, activePageIndex: 0 })
  }
})
