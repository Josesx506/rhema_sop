import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { presentSlideMock, clearPresentationMock } = vi.hoisted(() => ({
  presentSlideMock: vi.fn(),
  clearPresentationMock: vi.fn(),
}))

// A minimal stand-in for the real zustand store: fresh state + listeners on
// every re-import (the store test below calls vi.resetModules() between
// cases), while presentSlideMock/clearPresentationMock stay stable so call
// counts can be asserted and reset explicitly.
vi.mock("@/lib/presentation-broadcast", () => {
  type OnAirState = { onAir: { kind: string; dataUrl?: string } | null }
  type Listener = (state: OnAirState, prev: OnAirState) => void

  let currentState: OnAirState = { onAir: null }
  let listeners: Listener[] = []

  const usePresentationOnAir = {
    getState: () => currentState,
    setState: (partial: Partial<OnAirState>) => {
      const prev = currentState
      currentState = { ...currentState, ...partial }
      listeners.forEach((listener) => listener(currentState, prev))
    },
    subscribe: (listener: Listener) => {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },
  }

  return {
    presentSlide: presentSlideMock,
    clearPresentation: clearPresentationMock,
    usePresentationOnAir,
  }
})

function makeDeck(overrides: { pages?: string[] } = {}) {
  const pages = overrides.pages ?? ["page-1", "page-2", "page-3"]
  return { name: "Announcements", pages }
}

describe("slide store", () => {
  beforeEach(async () => {
    vi.resetModules()
    presentSlideMock.mockReset()
    clearPresentationMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("addDeck appends a deck with default interval and loop settings", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())

    expect(deck.intervalMs).toBe(8000)
    expect(deck.loop).toBe(true)
    expect(useSlideStore.getState().decks).toHaveLength(1)
    expect(useSlideStore.getState().decks[0].pages).toEqual(["page-1", "page-2", "page-3"])
  })

  it("removeDeck drops the deck and stops presenting if it was active", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().presentPage(deck.id, 0)

    useSlideStore.getState().removeDeck(deck.id)

    expect(useSlideStore.getState().decks).toHaveLength(0)
    expect(useSlideStore.getState().activeDeckId).toBeNull()
    expect(clearPresentationMock).toHaveBeenCalledTimes(1)
  })

  it("updateDeckSettings patches interval and loop", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())

    useSlideStore.getState().updateDeckSettings(deck.id, { intervalMs: 15000, loop: false })

    const updated = useSlideStore.getState().decks[0]
    expect(updated.intervalMs).toBe(15000)
    expect(updated.loop).toBe(false)
  })

  it("presentPage sets active deck/page and emits the slide", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())

    useSlideStore.getState().presentPage(deck.id, 1)

    expect(useSlideStore.getState().activeDeckId).toBe(deck.id)
    expect(useSlideStore.getState().activePageIndex).toBe(1)
    expect(presentSlideMock).toHaveBeenCalledWith("page-2")
  })

  it("presentPage clamps out-of-range indices", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())

    useSlideStore.getState().presentPage(deck.id, 99)
    expect(useSlideStore.getState().activePageIndex).toBe(2)

    useSlideStore.getState().presentPage(deck.id, -5)
    expect(useSlideStore.getState().activePageIndex).toBe(0)
  })

  it("nextPage/prevPage wrap around when the deck loops", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().presentPage(deck.id, 2)

    useSlideStore.getState().nextPage()
    expect(useSlideStore.getState().activePageIndex).toBe(0)

    useSlideStore.getState().prevPage()
    expect(useSlideStore.getState().activePageIndex).toBe(2)
  })

  it("nextPage/prevPage clamp at the edges when the deck does not loop", async () => {
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().updateDeckSettings(deck.id, { loop: false })
    useSlideStore.getState().presentPage(deck.id, 2)

    useSlideStore.getState().nextPage()
    expect(useSlideStore.getState().activePageIndex).toBe(2)

    useSlideStore.getState().presentPage(deck.id, 0)
    useSlideStore.getState().prevPage()
    expect(useSlideStore.getState().activePageIndex).toBe(0)
  })

  it("startLoop presents immediately then advances every intervalMs", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().updateDeckSettings(deck.id, { intervalMs: 1000 })

    useSlideStore.getState().startLoop(deck.id)

    expect(useSlideStore.getState().playing).toBe(true)
    expect(useSlideStore.getState().activePageIndex).toBe(0)
    expect(presentSlideMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    expect(useSlideStore.getState().activePageIndex).toBe(1)
    expect(presentSlideMock).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1000)
    expect(useSlideStore.getState().activePageIndex).toBe(2)

    vi.advanceTimersByTime(1000)
    expect(useSlideStore.getState().activePageIndex).toBe(0)
  })

  it("pauseLoop stops advancing but leaves the current slide on air", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().updateDeckSettings(deck.id, { intervalMs: 1000 })
    useSlideStore.getState().startLoop(deck.id)

    useSlideStore.getState().pauseLoop()
    expect(useSlideStore.getState().playing).toBe(false)

    const callsAtPause = presentSlideMock.mock.calls.length
    vi.advanceTimersByTime(5000)

    expect(presentSlideMock).toHaveBeenCalledTimes(callsAtPause)
    expect(clearPresentationMock).not.toHaveBeenCalled()
    expect(useSlideStore.getState().activeDeckId).toBe(deck.id)
  })

  it("presenting a page manually while playing re-bases the timer", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().updateDeckSettings(deck.id, { intervalMs: 1000 })
    useSlideStore.getState().startLoop(deck.id)

    vi.advanceTimersByTime(600)
    useSlideStore.getState().presentPage(deck.id, 2)
    expect(useSlideStore.getState().activePageIndex).toBe(2)

    // Old timer would have fired at 1000ms; it should have been re-based to
    // fire 1000ms after the manual jump instead.
    vi.advanceTimersByTime(400)
    expect(useSlideStore.getState().activePageIndex).toBe(2)

    vi.advanceTimersByTime(600)
    expect(useSlideStore.getState().activePageIndex).toBe(0)
  })

  it("stopPresenting clears the timer, resets state, and clears the presentation", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().startLoop(deck.id)

    useSlideStore.getState().stopPresenting()

    expect(useSlideStore.getState().playing).toBe(false)
    expect(useSlideStore.getState().activeDeckId).toBeNull()
    expect(clearPresentationMock).toHaveBeenCalledTimes(1)

    const callsAtStop = presentSlideMock.mock.calls.length
    vi.advanceTimersByTime(10000)
    expect(presentSlideMock).toHaveBeenCalledTimes(callsAtStop)
  })

  it("resets playing/active state when something else clears the presentation", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const { usePresentationOnAir } = await import("@/lib/presentation-broadcast")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().startLoop(deck.id)
    // The store's presentSlide call is mocked (a no-op), so drive a real
    // non-null -> null transition by hand to simulate a verse (or other
    // module) taking over the output and then clearing.
    usePresentationOnAir.setState({ onAir: { kind: "slide", dataUrl: "other" } })

    usePresentationOnAir.setState({ onAir: null })

    expect(useSlideStore.getState().playing).toBe(false)
    expect(useSlideStore.getState().activeDeckId).toBeNull()

    const callsAfterExternalClear = presentSlideMock.mock.calls.length
    vi.advanceTimersByTime(10000)
    expect(presentSlideMock).toHaveBeenCalledTimes(callsAfterExternalClear)
  })

  it("stops the loop when a media video displaces the slides", async () => {
    vi.useFakeTimers()
    const { useSlideStore } = await import("./slide-store")
    const { usePresentationOnAir } = await import("@/lib/presentation-broadcast")
    const deck = useSlideStore.getState().addDeck(makeDeck())
    useSlideStore.getState().startLoop(deck.id)

    // A media loop starting sets onAir to a video payload (never null) —
    // the slide timer must stop rather than fight the video for the output.
    usePresentationOnAir.setState({ onAir: { kind: "video", src: "loop.mp4" } })

    expect(useSlideStore.getState().playing).toBe(false)
    expect(useSlideStore.getState().activeDeckId).toBeNull()

    const callsAfterDisplacement = presentSlideMock.mock.calls.length
    vi.advanceTimersByTime(30000)
    expect(presentSlideMock).toHaveBeenCalledTimes(callsAfterDisplacement)
  })
})
