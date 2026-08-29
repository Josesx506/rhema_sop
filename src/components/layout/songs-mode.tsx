import { LiveOutputPanel } from "@/components/panels/live-output-panel"
import { SongCatalogPanel } from "@/components/songs/song-catalog-panel"
import { SetlistPanel } from "@/components/songs/setlist-panel"
import { SongPreviewPanel } from "@/components/songs/song-preview-panel"

/**
 * Songs mode layout (fork feature): catalog | setlist+blocks | preview/live.
 * Owns the grid; the panels it mounts are owned by the songs module.
 */
export function SongsMode() {
  return (
    <div
      className="col-span-4 row-span-2 grid min-h-0 gap-3 p-3 *:min-h-0"
      style={{
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 380px",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <SongCatalogPanel />
      <SetlistPanel />
      <div
        className="grid min-h-0 gap-3"
        style={{ gridTemplateRows: "minmax(0, 1fr) minmax(0, 1fr)" }}
      >
        <SongPreviewPanel />
        <LiveOutputPanel />
      </div>
    </div>
  )
}
