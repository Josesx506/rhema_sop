import { LiveOutputPanel } from "@/components/panels/live-output-panel"
import { DeckPanel } from "@/components/slides/deck-panel"
import { SlidePreviewPanel } from "@/components/slides/slide-preview-panel"
import { MediaPanel } from "@/components/media/media-panel"

/**
 * Presentation mode layout (fork feature): slide decks | media loops |
 * preview + live output. Owns the grid; the panels are owned by their
 * modules. The right column stacks the preview-before-live panel above the
 * live output so operators can stage a slide before it hits the display.
 */
export function PresentationMode() {
  return (
    <div
      className="col-span-4 row-span-2 grid min-h-0 gap-3 p-3 *:min-h-0"
      style={{
        gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr) 380px",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <DeckPanel />
      <MediaPanel />
      <div
        className="grid min-h-0 gap-3 *:min-h-0"
        style={{ gridTemplateRows: "minmax(0,1fr) minmax(0,1fr)" }}
      >
        <SlidePreviewPanel />
        <LiveOutputPanel />
      </div>
    </div>
  )
}
