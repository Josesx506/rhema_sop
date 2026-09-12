import type { NdiAlphaMode, NdiFrameRate, NdiResolution } from "./ndi"

export type BroadcastOutputType = "display" | "ndi"

export interface BroadcastOutputNdiSettings {
  sourceName: string
  resolution: NdiResolution
  frameRate: NdiFrameRate
  alphaMode: NdiAlphaMode
}

/**
 * Persisted configuration for one broadcast output. Whether the output is
 * currently on air (window open / NDI sender running) is runtime state,
 * reconciled from the OS — never persisted.
 */
export interface BroadcastOutput {
  /** "main" for the default output; crypto.randomUUID() otherwise. */
  id: string
  name: string
  type: BroadcastOutputType
  themeId: string
  /** Kept even while type === "ndi" so switching types is lossless. */
  monitorIndex: number
  ndi: BroadcastOutputNdiSettings
}

/**
 * Fork: what an output shows once it has faded out (idle fade or the
 * operator Blank).
 *
 * - "black": a full black screen.
 * - "theme": the theme background and logo, with only the text gone.
 * - "transparent": nothing at all — the frame's alpha goes to zero. Only
 *   meaningful for NDI, where the feed is a layer over someone else's video
 *   and any painted background would sit on the camera as a sheet.
 */
export type OutputFadeTarget = "black" | "theme" | "transparent"

/** Runtime on-air state for an output, reconciled from the OS. */
export interface BroadcastOutputStatus {
  previewOpen: boolean
  ndiActive: boolean
}

/** The default output: always present, editable, never deletable. */
export const MAIN_OUTPUT_ID = "main"

export const outputWindowLabel = (id: string) => `broadcast-${id}`

export const defaultNdiSettings = (sourceName = "Rhema"): BroadcastOutputNdiSettings => ({
  sourceName,
  resolution: "r1080p",
  frameRate: "fps24",
  alphaMode: "straightAlpha",
})
