import { LiveOutputPanel } from "@/components/panels/live-output-panel"
import { DeckPanel } from "@/components/slides/deck-panel"
import { MediaPanel } from "@/components/media/media-panel"

/**
 * Presentation mode layout (fork feature): slide decks | media loops |
 * live output. Owns the grid; the panels are owned by their modules.
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
      <LiveOutputPanel />
    </div>
  )
}
