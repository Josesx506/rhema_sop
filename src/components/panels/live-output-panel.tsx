import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { getAllWindows } from "@tauri-apps/api/window"
import { PanelHeader } from "@/components/ui/panel-header"
import { CanvasVerse } from "@/components/ui/canvas-verse"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useBroadcastStore, useBibleStore, useSettingsStore } from "@/stores"
import { presentVerse, toVerseRenderData } from "@/hooks/use-broadcast"
import { bibleActions } from "@/hooks/use-bible"
import { usePresentationOnAir } from "@/lib/presentation-broadcast"
import {
  PresentationLiveMirror,
  presentationMirrorVisible,
} from "@/components/ui/presentation-live-mirror"

async function hasOpenBroadcastWindow(): Promise<boolean> {
  const windows = await getAllWindows()
  // Output windows are labeled `broadcast-${outputId}` (see outputWindowLabel).
  return windows.some((w) => w.label.startsWith("broadcast-"))
}

export function LiveOutputPanel() {
  const isLive = useBroadcastStore((s) => s.isLive)
  const autoLive = useBroadcastStore((s) => s.autoLive)
  const outputBlanked = useBroadcastStore((s) => s.outputBlanked)
  const liveVerse = useBroadcastStore((s) => s.liveVerse)
  const themes = useBroadcastStore((s) => s.themes)
  const activeThemeId = useBroadcastStore((s) => s.activeThemeId)
  const idleFadeMs = useSettingsStore((s) => s.idleFadeMs)
  const activeTranslationId = useBibleStore((s) => s.activeTranslationId)

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0]
  const presentationOnAir = usePresentationOnAir((s) => s.onAir)
  const presentationShowing = presentationMirrorVisible(presentationOnAir, isLive)

  // The live output renders only what was explicitly presented — it no longer
  // follows the preview selection, so detections can't override the operator.
  const verseData = isLive ? liveVerse : null

  // Mirror the broadcast output's idle fade in the in-app preview.
  const [faded, setFaded] = useState(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    setFaded(false)
    if (verseData && !verseData.noAutoFade) {
      idleTimerRef.current = setTimeout(() => setFaded(true), idleFadeMs)
    }
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [verseData, idleFadeMs])

  // Refetch the live verse when the translation changes so the live output
  // text follows the new translation. Updates the live output only — the
  // preview keeps whatever the operator is browsing.
  useEffect(() => {
    const source = useBroadcastStore.getState().liveSourceVerse
    if (!source) return
    bibleActions
      .fetchVerse(source.book_number, source.chapter, source.verse)
      .then((v) => {
        if (!v) return
        const bible = useBibleStore.getState()
        const abbreviation =
          bible.translations.find((t) => t.id === bible.activeTranslationId)
            ?.abbreviation ?? "KJV"
        useBroadcastStore
          .getState()
          .setLiveVerse(toVerseRenderData(v, abbreviation), v)
      })
      .catch(() => {})
  }, [activeTranslationId])

  const handleGoLive = (checked: boolean) => {
    useBroadcastStore.getState().setLive(checked)
    // Going live with nothing presented yet: present the current preview
    // verse so the output isn't blank.
    if (checked && !useBroadcastStore.getState().liveVerse) {
      const selected = useBibleStore.getState().selectedVerse
      if (selected) void presentVerse(selected)
    }
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
  }

  return (
    <div
      data-slot="live-output-panel"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        isLive && "shadow-[inset_0_2px_0_0_rgba(16,185,129,0.3)]"
      )}
    >
      <PanelHeader title="Live display">
        {/* Fork: operator blank — fade the output to just the theme
            background (verse/song/slide state is kept and restored). */}
        <label
          className="mr-2 flex items-center gap-2"
          title="Fade the live output to just the theme background. Text and slides come back when turned off or when something new is presented. Videos are unaffected."
        >
          <span
            className={cn(
              "text-[0.625rem] font-medium uppercase tracking-wider transition-colors",
              outputBlanked ? "text-amber-400" : "text-muted-foreground"
            )}
          >
            Blank
          </span>
          <Switch
            checked={outputBlanked}
            onCheckedChange={(checked) =>
              useBroadcastStore.getState().setOutputBlanked(checked)
            }
            className="data-[state=checked]:bg-amber-500"
          />
        </label>
        <label
          className="flex items-center gap-2"
          title="When on, detected verses are presented to the live display automatically. Turn off for manual control."
        >
          <span
            className={cn(
              "text-[0.625rem] font-medium uppercase tracking-wider transition-colors",
              autoLive ? "text-foreground" : "text-muted-foreground"
            )}
          >
            Auto
          </span>
          <Switch
            checked={autoLive}
            onCheckedChange={(checked) =>
              useBroadcastStore.getState().setAutoLive(checked)
            }
          />
        </label>
        <label className="ml-2 flex items-center gap-2">
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
            onCheckedChange={handleGoLive}
            className="data-[state=checked]:bg-emerald-500"
          />
        </label>
      </PanelHeader>

      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center p-3 transition-opacity duration-700",
          !isLive && !presentationShowing && "opacity-40",
          faded && !presentationShowing && "opacity-0",
          // Mirror the operator blank: outputs fade to background only —
          // videos ignore the blank, so their mirror stays visible.
          outputBlanked && presentationOnAir?.kind !== "video" && "opacity-0"
        )}
      >
        {/* Fork: mirror slides/videos when the presentation channel owns
            the output — CanvasVerse only knows about the verse channel. */}
        {presentationShowing && presentationOnAir ? (
          <PresentationLiveMirror payload={presentationOnAir} />
        ) : (
          <CanvasVerse theme={activeTheme} verse={verseData} />
        )}
      </div>
    </div>
  )
}
