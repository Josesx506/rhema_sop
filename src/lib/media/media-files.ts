/**
 * File-picking helpers for the media loops module (fork-owned).
 *
 * Session-only: the operator picks a video file from disk each session.
 * Nothing is copied or persisted — the file streams from its on-disk path
 * via Tauri's asset protocol (convertFileSrc), matching the
 * PresentationPayload video contract in src/types/presentation.ts.
 */

import { open } from "@tauri-apps/plugin-dialog"
import { convertFileSrc } from "@tauri-apps/api/core"
import { toast } from "sonner"

/** Extensions accepted by the file picker's filter. */
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm"]

/** Extensions we're confident play back reliably as a looping mini-movie. */
const WELL_SUPPORTED_EXTENSIONS = new Set(VIDEO_EXTENSIONS)

export interface PickedVideoFile {
  /** Basename of the picked file, e.g. "announcement-loop.mp4". */
  name: string
  /** Absolute on-disk path, as returned by the native dialog. */
  path: string
  /** Streamable asset-protocol URL for presentVideo(). */
  src: string
}

/**
 * Warns (via toast) when a filename's extension isn't one of the
 * well-supported video formats. Still returns true/false rather than
 * throwing — the caller always proceeds; H.264 MP4 is merely recommended.
 */
export function isLikelySupported(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  const ok = WELL_SUPPORTED_EXTENSIONS.has(ext)
  if (!ok) {
    toast.warning(`"${name}" may not play reliably`, {
      description: "H.264 MP4 is the recommended format for smooth looping playback.",
    })
  }
  return ok
}

/**
 * Opens a native file dialog to pick a video file. Returns null if the
 * operator cancels. Does not read or copy the file — only its path.
 */
export async function pickVideoFile(): Promise<PickedVideoFile | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
  })
  if (!selected) return null

  const path = typeof selected === "string" ? selected : selected[0]
  if (!path) return null

  const name = path.split(/[\\/]/).pop() ?? path
  isLikelySupported(name)

  return { name, path, src: convertFileSrc(path) }
}
