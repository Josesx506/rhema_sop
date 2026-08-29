import { PanelHeader } from "@/components/ui/panel-header"
import { useSlideStore } from "@/stores/slide-store"

/**
 * Preview-before-live for slide decks (fork feature): clicking a thumbnail
 * in the deck panel only updates this preview — nothing reaches the
 * congregation display until the operator double-clicks the thumbnail to
 * present it (no separate go-live control here, matching Scripture mode).
 */
export function SlidePreviewPanel() {
  const decks = useSlideStore((s) => s.decks)
  const previewDeckId = useSlideStore((s) => s.previewDeckId)
  const previewPageIndex = useSlideStore((s) => s.previewPageIndex)

  const previewDeck = decks.find((d) => d.id === previewDeckId) ?? null
  const previewPage = previewDeck?.pages[previewPageIndex] ?? null

  return (
    <div
      data-slot="slide-preview-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Preview" />

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black">
          {previewDeck && previewPage ? (
            <img
              src={previewPage}
              alt={`${previewDeck.name} page ${previewPageIndex + 1}`}
              className="aspect-video size-full object-contain"
              draggable={false}
            />
          ) : (
            <p className="p-6 text-center text-xs text-muted-foreground">
              ⌥-click a slide to preview it
            </p>
          )}
        </div>
        {previewDeck && (
          <p className="shrink-0 truncate text-center text-xs text-muted-foreground">
            {previewDeck.name} — page {previewPageIndex + 1}/{previewDeck.pages.length}
          </p>
        )}
      </div>
    </div>
  )
}
