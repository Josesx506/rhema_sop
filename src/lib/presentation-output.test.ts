// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { PresentationController } from "./presentation-output"

interface DrawCall {
  x: number
  y: number
  width: number
  height: number
}

function fakeCtx(): {
  ctx: CanvasRenderingContext2D
  fills: DrawCall[]
  draws: DrawCall[]
} {
  const fills: DrawCall[] = []
  const draws: DrawCall[] = []
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    fillRect: (x: number, y: number, width: number, height: number) =>
      fills.push({ x, y, width, height }),
    drawImage: (_src: unknown, x: number, y: number, width: number, height: number) =>
      draws.push({ x, y, width, height }),
  } as unknown as CanvasRenderingContext2D
  return { ctx, fills, draws }
}

/** A decoded 16:9 slide, injected so the test needs no real image decode. */
function controllerWithSlide(naturalWidth = 1600, naturalHeight = 900) {
  const controller = new PresentationController({ redraw: vi.fn(), ndiBurst: vi.fn() })
  const image = new Image()
  Object.defineProperty(image, "naturalWidth", { value: naturalWidth })
  Object.defineProperty(image, "naturalHeight", { value: naturalHeight })
  const internals = controller as unknown as {
    content: unknown
    image: HTMLImageElement
  }
  internals.content = { kind: "slide", dataUrl: "data:,", fit: "contain" }
  internals.image = image
  return controller
}

describe("PresentationController.drawFrame", () => {
  it("returns false and paints nothing when no content is active", () => {
    const controller = new PresentationController({ redraw: vi.fn(), ndiBurst: vi.fn() })
    const { ctx, fills, draws } = fakeCtx()

    expect(controller.drawFrame(ctx, 1920, 1080)).toBe(false)
    expect(fills).toEqual([])
    expect(draws).toEqual([])
  })

  it("fills and fits the whole canvas when no region is given", () => {
    const { ctx, fills, draws } = fakeCtx()
    controllerWithSlide().drawFrame(ctx, 1920, 1080)

    expect(fills).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }])
    // 16:9 into 16:9 fills exactly, centred.
    expect(draws).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }])
  })

  it("confines the blackout and the image to the region it is given", () => {
    const { ctx, fills, draws } = fakeCtx()
    // A theme owning the left half of the frame.
    const region = { x: 0, y: 0, width: 960, height: 1080 }
    controllerWithSlide().drawFrame(ctx, 1920, 1080, region)

    // Crucially the fill does NOT cover the full canvas — the rest of the
    // frame belongs to whatever the output is overlaid on.
    expect(fills).toEqual([region])
    const [draw] = draws
    expect(draw.width).toBe(960)
    expect(draw.height).toBe(540)
    // Centred inside the region, not inside the canvas.
    expect(draw.x).toBe(0)
    expect(draw.y).toBe((1080 - 540) / 2)
  })

  it("offsets the image by the region's origin", () => {
    const { ctx, draws } = fakeCtx()
    const region = { x: 400, y: 200, width: 800, height: 450 }
    controllerWithSlide().drawFrame(ctx, 1920, 1080, region)

    expect(draws).toEqual([{ x: 400, y: 200, width: 800, height: 450 }])
  })

  it("skips a degenerate region instead of dividing by zero", () => {
    const { ctx, fills, draws } = fakeCtx()
    const drawn = controllerWithSlide().drawFrame(ctx, 1920, 1080, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })

    expect(drawn).toBe(true)
    expect(fills).toEqual([])
    expect(draws).toEqual([])
  })
})
