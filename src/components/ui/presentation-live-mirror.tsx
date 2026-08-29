import { useEffect, useRef } from "react"
import type { PresentationPayload } from "@/types/presentation"

type OnAirPayload = Exclude<PresentationPayload, { kind: "clear" }>

/**
 * In-app mirror of presentation content for the Live Display panel (fork).
 * The panel's CanvasVerse only mirrors the verse channel; when a slide or
 * video owns the output this renders what the congregation actually sees.
 *
 * Videos are mirrored with a muted local <video> — playback position isn't
 * frame-locked to the output window, which is fine for a monitor.
 */
export function presentationMirrorVisible(
  onAir: OnAirPayload | null,
  isLive: boolean
): boolean {
  if (!onAir) return false
  // Slides are gated by the Live toggle (see presentation-broadcast.ts);
  // videos bypass it and are on air whenever they play.
  return onAir.kind !== "slide" || isLive
}

export function PresentationLiveMirror({ payload }: { payload: OnAirPayload }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  const paused = payload.kind === "video" ? (payload.paused ?? false) : false
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (paused) el.pause()
    else void el.play().catch(() => {})
  }, [paused])

  if (payload.kind === "slide") {
    return (
      <img
        src={payload.dataUrl}
        alt="Live slide"
        className="max-h-full max-w-full rounded-md object-contain"
        draggable={false}
      />
    )
  }

  return (
    <video
      ref={videoRef}
      src={payload.src}
      muted
      autoPlay
      playsInline
      loop={payload.loop ?? true}
      className="max-h-full max-w-full rounded-md object-contain"
    />
  )
}
