import { LiveOutputPanel } from "@/components/panels/live-output-panel"
import { SongCatalogPanel } from "@/components/songs/song-catalog-panel"
import { SetlistPanel } from "@/components/songs/setlist-panel"

/**
 * Songs mode layout (fork feature): catalog | setlist+blocks | live output.
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
      <LiveOutputPanel />
    </div>
  )
}
