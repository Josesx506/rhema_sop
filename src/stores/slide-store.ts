import { create } from "zustand"
import {
  clearPresentation,
  presentSlide,
  usePresentationOnAir,
} from "@/lib/presentation-broadcast"

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

  addDeck: (deck: { name: string; pages: string[] }) => SlideDeck
  removeDeck: (id: string) => void
  updateDeckSettings: (
    id: string,
    settings: Partial<Pick<SlideDeck, "intervalMs" | "loop">>
  ) => void

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
    const { activeDeckId } = get()
    set((state) => ({ decks: state.decks.filter((d) => d.id !== id) }))
    if (activeDeckId === id) {
      get().stopPresenting()
    }
  },

  updateDeckSettings: (id, settings) =>
    set((state) => ({
      decks: state.decks.map((d) => (d.id === id ? { ...d, ...settings } : d)),
    })),

  presentPage: (deckId, index) => {
    const deck = get().decks.find((d) => d.id === deckId)
    if (!deck || deck.pages.length === 0) return
    const clamped = Math.max(0, Math.min(index, deck.pages.length - 1))
    set({ activeDeckId: deckId, activePageIndex: clamped })
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
