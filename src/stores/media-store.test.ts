import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock factories are hoisted above all imports (including plain
// const/let declarations), so any state they close over must itself be
// created inside vi.hoisted() to avoid a TDZ ReferenceError.
const mocks = vi.hoisted(() => {
  type OnAirListener = (state: { onAir: unknown }, prev: { onAir: unknown }) => void
  let onAirState: { onAir: unknown } = { onAir: null }
  let onAirListeners: OnAirListener[] = []

  return {
    presentVideoMock: vi.fn(),
    clearPresentationMock: vi.fn(),
    pickVideoFileMock: vi.fn(),
    resetOnAir: () => {
      onAirState = { onAir: null }
    },
    getOnAirState: () => onAirState,
    setOnAirState: (partial: Partial<{ onAir: unknown }>) => {
      const prev = onAirState
      onAirState = { ...onAirState, ...partial }
      for (const listener of onAirListeners) listener(onAirState, prev)
    },
    subscribeOnAir: (listener: OnAirListener) => {
      onAirListeners.push(listener)
      return () => {
        onAirListeners = onAirListeners.filter((l) => l !== listener)
      }
    },
  }
})

const { presentVideoMock, clearPresentationMock, pickVideoFileMock } = mocks

vi.mock("@/lib/presentation-broadcast", () => ({
  presentVideo: mocks.presentVideoMock,
  clearPresentation: mocks.clearPresentationMock,
  usePresentationOnAir: {
    getState: mocks.getOnAirState,
    setState: mocks.setOnAirState,
    subscribe: mocks.subscribeOnAir,
  },
}))

vi.mock("@/lib/media/media-files", () => ({
  pickVideoFile: mocks.pickVideoFileMock,
}))

import { useMediaStore, type MediaLoopItem } from "./media-store"
import { usePresentationOnAir } from "@/lib/presentation-broadcast"

function makeItem(overrides: Partial<MediaLoopItem> = {}): MediaLoopItem {
  return {
    id: "vid-1",
    name: "announcement.mp4",
    path: "/videos/announcement.mp4",
    src: "asset://localhost/videos/announcement.mp4",
    loop: true,
    volume: 0,
    ...overrides,
  }
}

beforeEach(() => {
  presentVideoMock.mockClear()
  clearPresentationMock.mockClear()
  pickVideoFileMock.mockReset()
  mocks.resetOnAir()
  useMediaStore.setState({ items: [], playingId: null })
})

describe("play", () => {
  it("presents the video with its loop/volume options and marks it on air", () => {
    const item = makeItem({ loop: false, volume: 0.4 })
    useMediaStore.setState({ items: [item] })

    useMediaStore.getState().play(item.id)

    expect(presentVideoMock).toHaveBeenCalledWith(item.src, { loop: false, volume: 0.4, paused: false })
    expect(useMediaStore.getState().playingId).toBe(item.id)
  })
})

describe("stop", () => {
  it("clears the presentation and unsets playingId", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item], playingId: item.id })

    useMediaStore.getState().stop()

    expect(clearPresentationMock).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().playingId).toBeNull()
    expect(useMediaStore.getState().paused).toBe(false)
  })
})

describe("togglePause", () => {
  it("pause re-presents with paused: true and KEEPS the channel (no clear)", () => {
    const item = makeItem({ loop: true, volume: 0.2 })
    useMediaStore.setState({ items: [item], playingId: item.id, paused: false })
    presentVideoMock.mockClear()

    useMediaStore.getState().togglePause()

    expect(presentVideoMock).toHaveBeenCalledWith(item.src, {
      loop: true,
      volume: 0.2,
      paused: true,
    })
    expect(clearPresentationMock).not.toHaveBeenCalled()
    expect(useMediaStore.getState().paused).toBe(true)
    expect(useMediaStore.getState().playingId).toBe(item.id)
  })

  it("resume re-presents with paused: false", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item], playingId: item.id, paused: true })
    presentVideoMock.mockClear()

    useMediaStore.getState().togglePause()

    expect(presentVideoMock).toHaveBeenCalledWith(item.src, {
      loop: item.loop,
      volume: item.volume,
      paused: false,
    })
    expect(useMediaStore.getState().paused).toBe(false)
  })

  it("is a no-op when nothing is playing", () => {
    useMediaStore.setState({ items: [makeItem()], playingId: null })
    presentVideoMock.mockClear()

    useMediaStore.getState().togglePause()

    expect(presentVideoMock).not.toHaveBeenCalled()
  })

  it("updateItem on a paused playing item keeps it paused", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item], playingId: item.id, paused: true })
    presentVideoMock.mockClear()

    useMediaStore.getState().updateItem(item.id, { volume: 0.5 })

    expect(presentVideoMock).toHaveBeenCalledWith(item.src, {
      loop: item.loop,
      volume: 0.5,
      paused: true,
    })
  })
})

describe("displacement", () => {
  it("resets playingId when onAir becomes null", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item] })
    // presentVideo is mocked (doesn't touch onAir itself), so simulate what
    // the real implementation does when a video goes on air.
    usePresentationOnAir.setState({ onAir: { kind: "video", src: item.src } })
    useMediaStore.getState().play(item.id)
    expect(useMediaStore.getState().playingId).toBe(item.id)

    usePresentationOnAir.setState({ onAir: null })

    expect(useMediaStore.getState().playingId).toBeNull()
  })

  it("resets playingId when onAir becomes a non-video (slide) payload", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item] })
    usePresentationOnAir.setState({ onAir: { kind: "video", src: item.src } })
    useMediaStore.getState().play(item.id)

    usePresentationOnAir.setState({
      onAir: { kind: "slide", dataUrl: "data:image/png;base64,xyz" },
    })

    expect(useMediaStore.getState().playingId).toBeNull()
  })

  it("does not reset playingId for an unrelated onAir change when nothing is playing", () => {
    usePresentationOnAir.setState({ onAir: { kind: "slide", dataUrl: "x" } })

    expect(useMediaStore.getState().playingId).toBeNull()
  })
})

describe("updateItem", () => {
  it("re-presents the currently playing item with new options", () => {
    const item = makeItem({ loop: true, volume: 0 })
    useMediaStore.setState({ items: [item] })
    useMediaStore.getState().play(item.id)
    presentVideoMock.mockClear()

    useMediaStore.getState().updateItem(item.id, { volume: 0.7 })

    expect(presentVideoMock).toHaveBeenCalledWith(item.src, { loop: true, volume: 0.7, paused: false })
    expect(useMediaStore.getState().items[0].volume).toBe(0.7)
  })

  it("does not re-present an item that isn't playing", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item], playingId: null })

    useMediaStore.getState().updateItem(item.id, { loop: false })

    expect(presentVideoMock).not.toHaveBeenCalled()
    expect(useMediaStore.getState().items[0].loop).toBe(false)
  })
})

describe("removeItem", () => {
  it("clears the presentation when removing the playing item", () => {
    const item = makeItem()
    useMediaStore.setState({ items: [item] })
    useMediaStore.getState().play(item.id)
    clearPresentationMock.mockClear()

    useMediaStore.getState().removeItem(item.id)

    expect(clearPresentationMock).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().playingId).toBeNull()
    expect(useMediaStore.getState().items).toHaveLength(0)
  })
})

describe("addItem", () => {
  it("adds a picked video with default loop=true, volume=0", async () => {
    pickVideoFileMock.mockResolvedValue({
      name: "loop.mp4",
      path: "/videos/loop.mp4",
      src: "asset://localhost/videos/loop.mp4",
    })

    await useMediaStore.getState().addItem()

    const items = useMediaStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: "loop.mp4",
      path: "/videos/loop.mp4",
      src: "asset://localhost/videos/loop.mp4",
      loop: true,
      volume: 0,
    })
  })

  it("does nothing when the picker is cancelled", async () => {
    pickVideoFileMock.mockResolvedValue(null)

    await useMediaStore.getState().addItem()

    expect(useMediaStore.getState().items).toHaveLength(0)
  })
})
