/**
 * Output-window side of the presentation contract (fork-owned).
 *
 * Owns everything about drawing slides/videos onto the broadcast canvas so
 * the mount in broadcast-output.tsx stays a few lines: it forwards payloads
 * here and asks `drawFrame` first in its draw path.
 *
 * Videos are decoded by a hidden <video> element and blitted to the canvas
 * every frame via requestVideoFrameCallback, so display windows and the
 * NDI frame-push see the same pixels.
 */

import type { PresentationPayload } from "@/types/presentation"

interface PresentationCallbacks {
  /** Ask the host to redraw the canvas (host calls drawFrame from its draw). */
  redraw: () => void
  /** Push an NDI frame burst after visible content changes. */
  ndiBurst: () => void
}

export class PresentationController {
  private content: Exclude<PresentationPayload, { kind: "clear" }> | null = null
  private image: HTMLImageElement | null = null
  private video: HTMLVideoElement | null = null
  private vfcHandle: number | null = null
  private readonly cb: PresentationCallbacks

  constructor(callbacks: PresentationCallbacks) {
    this.cb = callbacks
  }

  /** True while presentation content owns the output. */
  get active(): boolean {
    return this.content !== null
  }

  handlePayload(payload: PresentationPayload): void {
    if (payload.kind === "clear") {
      this.teardown()
      this.cb.redraw()
      this.cb.ndiBurst()
      return
    }

    // Same-src video payloads update in place — pause/resume/loop/volume
    // changes must not restart playback from the beginning. (Stop → play
    // DOES restart, because clear tears the element down.)
    if (
      payload.kind === "video" &&
      this.content?.kind === "video" &&
      this.content.src === payload.src &&
      this.video
    ) {
      this.content = payload
      this.video.loop = payload.loop ?? true
      this.video.volume = payload.volume ?? 0
      this.video.muted = (payload.volume ?? 0) === 0
      if (payload.paused && !this.video.paused) {
        this.video.pause()
        // rVFC stops firing while paused; push the held frame so NDI
        // receivers see it before the keepalive would.
        this.cb.redraw()
        this.cb.ndiBurst()
      } else if (!payload.paused && this.video.paused) {
        void this.video.play().catch(() => {})
      }
      return
    }

    this.teardown()
    this.content = payload

    if (payload.kind === "slide") {
      const img = new Image()
      img.onload = () => {
        // A later payload may have replaced this one while it decoded.
        if (this.content === payload) {
          this.image = img
          this.cb.redraw()
          this.cb.ndiBurst()
        }
      }
      img.onerror = () => {
        console.warn("[presentation-output] slide image failed to decode")
      }
      img.src = payload.dataUrl
      return
    }

    // kind === "video"
    const video = document.createElement("video")
    video.src = payload.src
    video.loop = payload.loop ?? true
    video.muted = (payload.volume ?? 0) === 0
    video.volume = payload.volume ?? 0
    video.playsInline = true
    video.style.display = "none"
    document.body.appendChild(video)
    this.video = video

    const pump = () => {
      if (this.video !== video) return // torn down
      this.cb.redraw()
      this.vfcHandle = video.requestVideoFrameCallback(pump)
    }
    video
      .play()
      .then(() => {
        this.cb.ndiBurst()
        this.vfcHandle = video.requestVideoFrameCallback(pump)
      })
      .catch((e) => {
        console.warn("[presentation-output] video play failed", e)
      })
  }

  /**
   * Draw the current presentation frame. Returns false when nothing is
   * active (host then draws the normal verse scene).
   *
   * `region` bounds the content to the theme's background area rather than
   * the whole canvas, so a theme that only owns part of the frame — a lower
   * third, a side panel — does not black out what it is overlaid on. Omit it
   * for the full frame.
   */
  drawFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    region?: { x: number; y: number; width: number; height: number }
  ): boolean {
    const content = this.content
    if (!content) return false

    const box = region ?? { x: 0, y: 0, width, height }
    if (box.width <= 0 || box.height <= 0) return true

    ctx.globalAlpha = 1
    ctx.fillStyle = "#000"
    ctx.fillRect(box.x, box.y, box.width, box.height)

    const source =
      content.kind === "slide"
        ? this.image
        : this.video && this.video.readyState >= 2
          ? this.video
          : null
    if (!source) return true // black frame until the asset is ready

    const srcW =
      source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
    const srcH =
      source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
    if (!srcW || !srcH) return true

    const fit = content.kind === "slide" ? (content.fit ?? "contain") : "contain"
    const srcRatio = srcW / srcH
    const dstRatio = box.width / box.height
    let drawW = box.width
    let drawH = box.height
    if (fit === "contain" ? srcRatio > dstRatio : srcRatio < dstRatio) {
      drawH = box.width / srcRatio
    } else {
      drawW = box.height * srcRatio
    }
    ctx.drawImage(
      source,
      box.x + (box.width - drawW) / 2,
      box.y + (box.height - drawH) / 2,
      drawW,
      drawH
    )
    return true
  }

  private teardown(): void {
    this.content = null
    this.image = null
    if (this.video) {
      if (this.vfcHandle !== null) {
        this.video.cancelVideoFrameCallback(this.vfcHandle)
        this.vfcHandle = null
      }
      this.video.pause()
      this.video.removeAttribute("src")
      this.video.load()
      this.video.remove()
      this.video = null
    }
  }

  dispose(): void {
    this.teardown()
  }
}
