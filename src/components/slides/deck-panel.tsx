import { PanelHeader } from "@/components/ui/panel-header"

/** Placeholder — implemented by the slides module agent. */
export function DeckPanel() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <PanelHeader title="Slide decks" />
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Slides module under construction
      </div>
    </div>
  )
}
