import { beforeEach, describe, expect, it, vi } from "vitest"

const emitToMock = vi.fn()

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: emitToMock,
}))

const SLIDE_URL = "data:image/jpeg;base64,abc"

function presentationEmits(): unknown[] {
  return emitToMock.mock.calls
    .filter(([, event]) => event === "broadcast:presentation-update")
    .map(([, , payload]) => payload)
}

describe("presentation operator blank", () => {
  beforeEach(() => {
    emitToMock.mockReset()
    emitToMock.mockResolvedValue(undefined)
    vi.resetModules()
  })

  it("blank clears an on-air slide and unblank restores it while live", async () => {
    const { useBroadcastStore } = await import("@/stores/broadcast-store")
    const { presentSlide } = await import("./presentation-broadcast")
    useBroadcastStore.setState({ isLive: true })
    presentSlide(SLIDE_URL)

    emitToMock.mockClear()
    useBroadcastStore.getState().setOutputBlanked(true)
    expect(presentationEmits()).toContainEqual({ kind: "clear" })

    emitToMock.mockClear()
    useBroadcastStore.getState().setOutputBlanked(false)
    expect(presentationEmits()).toContainEqual(
      expect.objectContaining({ kind: "slide", dataUrl: SLIDE_URL })
    )
  })

  it("presenting a slide while blanked releases the blank", async () => {
    const { useBroadcastStore } = await import("@/stores/broadcast-store")
    const { presentSlide } = await import("./presentation-broadcast")
    useBroadcastStore.setState({ isLive: true })
    useBroadcastStore.getState().setOutputBlanked(true)

    presentSlide(SLIDE_URL)

    expect(useBroadcastStore.getState().outputBlanked).toBe(false)
    expect(presentationEmits()).toContainEqual(
      expect.objectContaining({ kind: "slide", dataUrl: SLIDE_URL })
    )
  })

  it("videos ignore the blank toggle", async () => {
    const { useBroadcastStore } = await import("@/stores/broadcast-store")
    const { presentVideo } = await import("./presentation-broadcast")
    presentVideo("asset://loop.mp4")

    emitToMock.mockClear()
    useBroadcastStore.getState().setOutputBlanked(true)
    expect(presentationEmits()).toEqual([])
    expect(useBroadcastStore.getState().outputBlanked).toBe(true)
  })

  it("a different live verse releases the blank; a keepalive re-stamp does not", async () => {
    const { useBroadcastStore } = await import("@/stores/broadcast-store")
    await import("./presentation-broadcast")
    const verse = {
      reference: "John 3:16",
      segments: [{ text: "For God so loved the world", verseNumber: 16 }],
      presentedAt: 1000,
    }
    useBroadcastStore.setState({ isLive: true })
    useBroadcastStore.getState().setLiveVerse(verse)
    useBroadcastStore.getState().setOutputBlanked(true)

    // Keepalive re-presents the same content with a fresh stamp.
    useBroadcastStore.getState().setLiveVerse({ ...verse, presentedAt: 2000 })
    expect(useBroadcastStore.getState().outputBlanked).toBe(true)

    useBroadcastStore.getState().setLiveVerse({
      reference: "John 3:17",
      segments: [{ text: "For God sent not his Son", verseNumber: 17 }],
      presentedAt: 3000,
    })
    expect(useBroadcastStore.getState().outputBlanked).toBe(false)
  })
})
