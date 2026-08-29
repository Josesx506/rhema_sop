import { PanelHeader } from "@/components/ui/panel-header"

/** Placeholder — implemented by the songs module agent. */
export function SetlistPanel() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <PanelHeader title="Setlist" />
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Songs module under construction
      </div>
    </div>
  )
}
