import { PanelHeader } from "@/components/ui/panel-header"
import { CanvasVerse } from "@/components/ui/canvas-verse"
import { useBroadcastStore } from "@/stores/broadcast-store"
import { useSongStore } from "@/stores/song-store"
import { blockToRenderData } from "@/lib/songs/song-to-render-data"

/**
 * Preview step for the songs module: single-clicking a setlist block lands
 * here (see setlist-panel.tsx), never straight onto the live output. The
 * operator presents with Enter or a double-click on the block; the Live
 * pane's toggle governs whether the output is on air (same as Scripture
 * mode — no separate go-live control here).
 */
export function SongPreviewPanel() {
  const setlist = useSongStore((s) => s.setlist)
  const previewEntryId = useSongStore((s) => s.previewEntryId)
  const previewBlockId = useSongStore((s) => s.previewBlockId)
  const themes = useBroadcastStore((s) => s.themes)
  const activeThemeId = useBroadcastStore((s) => s.activeThemeId)

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0]

  const previewEntry = setlist.find((e) => e.id === previewEntryId)
  const previewBlock = previewEntry?.blocks.find((b) => b.id === previewBlockId)

  const verseData = previewEntry && previewBlock ? blockToRenderData(previewEntry.title, previewBlock) : null

  return (
    <div
      data-slot="song-preview-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Preview" />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3">
        {verseData && previewBlock ? (
          <>
            <CanvasVerse theme={activeTheme} verse={verseData} className="min-h-0" />
            <span className="truncate text-xs text-muted-foreground">{previewBlock.label}</span>
          </>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            ⌥-click a setlist block (or use arrow keys) to preview it
          </p>
        )}
      </div>
    </div>
  )
}
