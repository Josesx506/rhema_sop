/**
 * Presentation (slides + media loops) broadcast contract.
 * Fork-owned file — see todo.md "Slides / presentation feature".
 *
 * Presentation content takes over an output window entirely: it draws over
 * the theme/verse scene, ignores the idle fade, and is dismissed with
 * {kind: "clear"} (which returns the output to the normal verse scene).
 */

/** Event name for presentation content, emitted per output window. */
export const PRESENTATION_UPDATE_EVENT = "broadcast:presentation-update"

export type PresentationPayload =
  | {
      kind: "slide"
      /** Rendered page image (JPEG/PNG data URL). */
      dataUrl: string
      /** How to fit the frame; default "contain" (letterbox on black). */
      fit?: "contain" | "cover"
    }
  | {
      kind: "video"
      /**
       * Streamable URL for the output webview — produced with
       * convertFileSrc() from the picked file path (asset protocol).
       */
      src: string
      /** Loop playback; default true (mini-movie loops). */
      loop?: boolean
      /** Playback volume 0..1; default 0 (announcement loops are silent). */
      volume?: number
      /** Hold the current frame (video keeps the channel; resume with
       * paused: false). A payload with the same src updates in place —
       * playback position is preserved. */
      paused?: boolean
    }
  | { kind: "clear" }
