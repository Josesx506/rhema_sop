/**
 * Main-window side of the presentation contract (fork-owned).
 * Emits slide/video/clear payloads to every configured output window,
 * mirroring how broadcast-store emits verse updates.
 */

import { emitTo } from "@tauri-apps/api/event"
import { create } from "zustand"
import { outputWindowLabel } from "@/types"
import {
  PRESENTATION_UPDATE_EVENT,
  type PresentationPayload,
} from "@/types/presentation"
import { useBroadcastStore } from "@/stores/broadcast-store"

/**
 * What presentation content is currently on air, if any — lets panels show
 * an on-air indicator and lets modules displace each other cleanly
 * (starting a video while a slide is up, etc.).
 */
interface PresentationOnAirState {
  onAir: Exclude<PresentationPayload, { kind: "clear" }> | null
}

export const usePresentationOnAir = create<PresentationOnAirState>(() => ({
  onAir: null,
}))

function emitToAllOutputs(payload: PresentationPayload): void {
  for (const output of useBroadcastStore.getState().outputs) {
    void emitTo(outputWindowLabel(output.id), PRESENTATION_UPDATE_EVENT, payload).catch(
      () => {}
    )
  }
}

export function presentSlide(dataUrl: string, fit?: "contain" | "cover"): void {
  const payload = { kind: "slide" as const, dataUrl, fit }
  usePresentationOnAir.setState({ onAir: payload })
  // Explicitly presenting a slide releases the operator blank — the click
  // means "show this now".
  if (useBroadcastStore.getState().outputBlanked) {
    useBroadcastStore.getState().setOutputBlanked(false)
  }
  // Slides are gated by the Live toggle like verses and songs — the
  // selection is remembered and goes out when Live flips on (see the
  // isLive subscription below). Videos deliberately bypass the gate.
  if (useBroadcastStore.getState().isLive) emitToAllOutputs(payload)
}

export function presentVideo(
  src: string,
  opts?: { loop?: boolean; volume?: number; paused?: boolean }
): void {
  const payload = { kind: "video" as const, src, ...opts }
  usePresentationOnAir.setState({ onAir: payload })
  emitToAllOutputs(payload)
}

export function clearPresentation(): void {
  usePresentationOnAir.setState({ onAir: null })
  emitToAllOutputs({ kind: "clear" })
}

// Last-wins across channels: explicitly presenting a verse (or song block —
// both land in liveVerse) takes the output back from any slide/video, so a
// scripture cue can interrupt an announcement loop without a separate
// "stop presentation" step.
useBroadcastStore.subscribe((state, prev) => {
  if (
    state.liveVerse &&
    state.liveVerse !== prev.liveVerse &&
    usePresentationOnAir.getState().onAir
  ) {
    clearPresentation()
  }
})

// The Live toggle gates slides exactly like verses/songs: flipping it on
// puts the remembered slide on air, flipping it off blanks the outputs but
// keeps the selection so it comes back with the toggle. Videos bypass the
// gate entirely (they have no preview and no theme — see media module).
useBroadcastStore.subscribe((state, prev) => {
  if (state.isLive === prev.isLive) return
  const { onAir } = usePresentationOnAir.getState()
  if (onAir?.kind !== "slide") return
  if (state.isLive) {
    emitToAllOutputs(onAir)
  } else {
    emitToAllOutputs({ kind: "clear" })
  }
})

// ── Operator blank (see broadcast-store.outputBlanked) ──
// While blanked, outputs show only the theme background: the verse channel
// emits null (handled in broadcast-store's sync) and on-air slides are
// cleared here — both keep their logical state so unblanking restores them.
// Videos deliberately ignore the blank: they own the whole frame and have
// their own Pause/Stop controls.

useBroadcastStore.subscribe((state, prev) => {
  if (state.outputBlanked === prev.outputBlanked) return
  const { onAir } = usePresentationOnAir.getState()
  if (onAir?.kind !== "slide") return
  if (state.outputBlanked) {
    emitToAllOutputs({ kind: "clear" })
  } else if (state.isLive) {
    emitToAllOutputs(onAir)
  }
})

/** Same on-screen content, ignoring presentedAt re-stamps (the transcript
 * keepalive re-presents the identical verse to hold off the idle fade —
 * that must not release an operator blank). */
function sameLiveContent(
  a: { reference: string; footerLabel?: string; segments: { text: string; verseNumber?: number }[] },
  b: { reference: string; footerLabel?: string; segments: { text: string; verseNumber?: number }[] }
): boolean {
  return (
    a.reference === b.reference &&
    a.footerLabel === b.footerLabel &&
    a.segments.length === b.segments.length &&
    a.segments.every(
      (seg, i) => seg.text === b.segments[i].text && seg.verseNumber === b.segments[i].verseNumber
    )
  )
}

// Presenting genuinely different content releases the blank — the operator's
// click means "show this now", so the next song block / verse just works.
useBroadcastStore.subscribe((state, prev) => {
  if (!state.outputBlanked) return
  if (!state.liveVerse || state.liveVerse === prev.liveVerse) return
  if (prev.liveVerse && sameLiveContent(state.liveVerse, prev.liveVerse)) return
  state.setOutputBlanked(false)
})

/**
 * Re-send the current presentation content to one output (e.g. a window
 * that opened after the content went on air). No-op when nothing is on air.
 */
export function resyncPresentationTo(outputId: string): void {
  const { onAir } = usePresentationOnAir.getState()
  if (!onAir) return
  // A blanked output stays blank — slides come back when the blank lifts.
  if (onAir.kind === "slide" && useBroadcastStore.getState().outputBlanked) return
  void emitTo(outputWindowLabel(outputId), PRESENTATION_UPDATE_EVENT, onAir).catch(
    () => {}
  )
}
