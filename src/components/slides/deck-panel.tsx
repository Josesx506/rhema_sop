import {
  FileUpIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  TrashIcon,
} from "lucide-react"
import { PanelHeader } from "@/components/ui/panel-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useSlideStore, type SlideDeck } from "@/stores/slide-store"
import { usePresentationOnAir } from "@/lib/presentation-broadcast"

const MIN_INTERVAL_S = 3
const MAX_INTERVAL_S = 60

function DeckThumbnails({
  deck,
  activeDeckId,
  activePageIndex,
  previewDeckId,
  previewPageIndex,
  liveDataUrl,
  playing,
}: {
  deck: SlideDeck
  activeDeckId: string | null
  activePageIndex: number
  previewDeckId: string | null
  previewPageIndex: number
  liveDataUrl: string | null
  playing: boolean
}) {
  // Single click presents (re-basing the loop when playing) — same
  // convention as Scripture-mode queue rows and song blocks, one click per
  // slide. ⌥-click previews without touching the output.
  const handleClick = (index: number, altKey: boolean) => {
    const store = useSlideStore.getState()
    if (altKey) {
      store.previewPage(deck.id, index)
    } else if (store.playing) {
      store.startLoop(deck.id, index)
    } else {
      store.presentPage(deck.id, index)
    }
  }

  return (
    <div className="grid grid-cols-3 gap-1.5 p-2 pt-0 sm:grid-cols-4">
      {deck.pages.map((page, index) => {
        const isSelected = activeDeckId === deck.id && activePageIndex === index
        const isLive = isSelected && !!liveDataUrl && liveDataUrl === page
        const isPreviewed = previewDeckId === deck.id && previewPageIndex === index
        return (
          <button
            key={index}
            type="button"
            onClick={(e) => handleClick(index, e.altKey)}
            title="Click to present · ⌥-click to preview"
            className={cn(
              "group relative aspect-video overflow-hidden rounded-md border bg-black/40 transition-colors",
              isLive
                ? "border-primary ring-2 ring-primary/50"
                : isPreviewed
                  ? "border-primary/50 ring-1 ring-primary/30"
                  : "border-border hover:border-primary/40"
            )}
          >
            <img
              src={page}
              alt={`${deck.name} page ${index + 1}`}
              // contain, not cover: document-style pages crop to their blank
              // white centers under cover, making thumbnails look empty.
              className="size-full object-contain"
              draggable={false}
            />
            <span className="absolute bottom-0.5 right-1 rounded bg-black/60 px-1 text-[0.5625rem] font-medium text-white">
              {index + 1}
            </span>
            {isLive && (
              <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-destructive px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wider text-destructive-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full bg-white",
                    playing && "animate-pulse"
                  )}
                />
                Live
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function DeckRow({
  deck,
  activeDeckId,
  activePageIndex,
  previewDeckId,
  previewPageIndex,
  playing,
  liveDataUrl,
}: {
  deck: SlideDeck
  activeDeckId: string | null
  activePageIndex: number
  previewDeckId: string | null
  previewPageIndex: number
  playing: boolean
  liveDataUrl: string | null
}) {
  // Uncontrolled + keyed on intervalMs: no local React state to desync from
  // the store, and typing isn't clamped/re-rendered on every keystroke —
  // only committed on blur/Enter.
  const commitInterval = (input: HTMLInputElement) => {
    const parsed = Number(input.value)
    if (!Number.isFinite(parsed)) {
      input.value = String(Math.round(deck.intervalMs / 1000))
      return
    }
    const clamped = Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round(parsed)))
    input.value = String(clamped)
    useSlideStore.getState().updateDeckSettings(deck.id, { intervalMs: clamped * 1000 })
  }

  return (
    <div className="border-b border-border pb-2 last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {deck.name}
        </span>
        <Badge variant="outline" className="shrink-0 text-[0.625rem]">
          {deck.pages.length} {deck.pages.length === 1 ? "slide" : "slides"}
        </Badge>
        <div className="flex shrink-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
          <Input
            key={deck.intervalMs}
            type="number"
            min={MIN_INTERVAL_S}
            max={MAX_INTERVAL_S}
            defaultValue={Math.round(deck.intervalMs / 1000)}
            onBlur={(e) => commitInterval(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            className="h-6 w-12 px-1.5 text-center text-[0.6875rem]"
          />
          <span>s</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Remove deck"
          onClick={() => useSlideStore.getState().removeDeck(deck.id)}
        >
          <TrashIcon />
        </Button>
      </div>
      <DeckThumbnails
        deck={deck}
        activeDeckId={activeDeckId}
        activePageIndex={activePageIndex}
        previewDeckId={previewDeckId}
        previewPageIndex={previewPageIndex}
        liveDataUrl={liveDataUrl}
        playing={playing}
      />
    </div>
  )
}

export function DeckPanel() {
  const decks = useSlideStore((s) => s.decks)
  const activeDeckId = useSlideStore((s) => s.activeDeckId)
  const activePageIndex = useSlideStore((s) => s.activePageIndex)
  const previewDeckId = useSlideStore((s) => s.previewDeckId)
  const previewPageIndex = useSlideStore((s) => s.previewPageIndex)
  const playing = useSlideStore((s) => s.playing)
  const importing = useSlideStore((s) => s.importing)
  const importProgress = useSlideStore((s) => s.importProgress)
  const onAir = usePresentationOnAir((s) => s.onAir)

  const liveDataUrl = onAir?.kind === "slide" ? onAir.dataUrl : null

  // The import itself lives in the store (importDeck) so it keeps running
  // and reporting progress even if this panel unmounts mid-import — the
  // panel here just renders whatever the store is currently doing.
  const handleImport = () => {
    void useSlideStore.getState().importDeck()
  }

  const importLabel = importing
    ? importProgress
      ? `Rendering ${importProgress.done}/${importProgress.total}…`
      : "Importing…"
    : "Import PDF"

  const importPct = importProgress
    ? Math.round((importProgress.done / importProgress.total) * 100)
    : 0

  const handlePlayPause = () => {
    if (!activeDeckId) return
    if (playing) {
      useSlideStore.getState().pauseLoop()
    } else {
      useSlideStore.getState().startLoop(activeDeckId, activePageIndex)
    }
  }

  return (
    <div
      data-slot="deck-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Slide decks">
        <div className="flex items-center gap-1">
          {activeDeckId && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                title={playing ? "Pause" : "Play"}
                onClick={handlePlayPause}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Stop"
                onClick={() => useSlideStore.getState().stopPresenting()}
              >
                <SquareIcon />
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={importing}
            onClick={handleImport}
          >
            {importing ? <Loader2Icon className="animate-spin" /> : <FileUpIcon />}
            {importLabel}
          </Button>
        </div>
      </PanelHeader>

      {importing && (
        <div className="h-0.5 w-full bg-border">
          <div
            className={cn(
              "h-full bg-primary transition-[width]",
              !importProgress && "w-1/12 animate-pulse"
            )}
            style={importProgress ? { width: `${importPct}%` } : undefined}
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:w-full">
        {decks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-xs text-muted-foreground">
              Import a PDF — PowerPoint/Keynote/Canva decks export to PDF
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {decks.map((deck) => (
              <DeckRow
                key={deck.id}
                deck={deck}
                activeDeckId={activeDeckId}
                activePageIndex={activePageIndex}
                previewDeckId={previewDeckId}
                previewPageIndex={previewPageIndex}
                playing={playing}
                liveDataUrl={liveDataUrl}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
