import { PanelHeader } from "@/components/ui/panel-header"

/** Placeholder — implemented by the media module agent. */
export function MediaPanel() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <PanelHeader title="Media loops" />
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Media module under construction
      </div>
    </div>
  )
}
