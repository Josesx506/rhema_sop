import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { getAllWindows } from "@tauri-apps/api/window"
import { PanelHeader } from "@/components/ui/panel-header"
import { CanvasVerse } from "@/components/ui/canvas-verse"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useBroadcastStore, useBibleStore, useSettingsStore } from "@/stores"
import { deriveLiveVerse } from "@/hooks/use-broadcast"

async function hasOpenBroadcastWindow(): Promise<boolean> {
  const windows = await getAllWindows()
  return windows.some((w) => w.label === "broadcast" || w.label === "broadcast-alt")
}

export function LiveOutputPanel() {
  const isLive = useBroadcastStore((s) => s.isLive)
  const themes = useBroadcastStore((s) => s.themes)
  const activeThemeId = useBroadcastStore((s) => s.activeThemeId)
  const idleFadeMs = useSettingsStore((s) => s.idleFadeMs)

  // Read the same data source as the preview panel
  const selectedVerse = useBibleStore((s) => s.selectedVerse)
  const translations = useBibleStore((s) => s.translations)
  const activeTranslationId = useBibleStore((s) => s.activeTranslationId)

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0]
  const translation =
    translations.find((t) => t.id === activeTranslationId)?.abbreviation ?? "KJV"

  const verseData = deriveLiveVerse({
    isLive,
    selectedVerse,
    translation,
  })

  const [faded, setFaded] = useState(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    useBroadcastStore.getState().setLiveVerse(verseData)

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (verseData) {
      setFaded(false)
      idleTimerRef.current = setTimeout(() => setFaded(true), idleFadeMs)
    } else {
      setFaded(false)
    }

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [verseData, idleFadeMs])

  return (
    <div
      data-slot="live-output-panel"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        isLive && "shadow-[inset_0_2px_0_0_rgba(16,185,129,0.3)]"
      )}
    >
      <PanelHeader title="Live display">
        <label className="flex items-center gap-2">
          <span
            className={cn(
              "text-[0.625rem] font-medium uppercase tracking-wider transition-colors",
              isLive ? "text-emerald-400" : "text-muted-foreground"
            )}
          >
            {isLive ? "Live" : "Go live"}
          </span>
          <Switch
            checked={isLive}
            onCheckedChange={(checked) => {
              useBroadcastStore.getState().setLive(checked)
              if (checked) {
                void hasOpenBroadcastWindow().then((open) => {
                  if (!open) {
                    toast.warning("No broadcast window open", {
                      description:
                        "Go live won't be visible to the congregation until you open a broadcast window in Broadcast Settings.",
                    })
                  }
                })
              }
            }}
            className="data-[state=checked]:bg-emerald-500"
          />
        </label>
      </PanelHeader>

      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center p-3 transition-opacity duration-700",
          !isLive && "opacity-40",
          faded && "opacity-0"
        )}
      >
        <CanvasVerse theme={activeTheme} verse={verseData} />
      </div>
    </div>
  )
}
