import { PlayIcon, PlusIcon, SquareIcon, XIcon, FilmIcon } from "lucide-react"
import { PanelHeader } from "@/components/ui/panel-header"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import { useMediaStore, type MediaLoopItem } from "@/stores/media-store"

function MediaItemRow({ item, isPlaying }: { item: MediaLoopItem; isPlaying: boolean }) {
  const handleToggle = () => {
    if (isPlaying) {
      useMediaStore.getState().stop()
    } else {
      useMediaStore.getState().play(item.id)
    }
  }

  const handleRemove = () => {
    useMediaStore.getState().removeItem(item.id)
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-2.5 py-2 transition-colors",
        isPlaying ? "border-primary/50 bg-primary/10 ring-1 ring-primary/40" : "border-border"
      )}
    >
      <div className="flex items-center gap-2">
        <FilmIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium text-foreground" title={item.path}>
          {item.name}
        </span>
        {isPlaying && (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-destructive">
            <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            Live
          </span>
        )}
        <Button
          variant={isPlaying ? "destructive" : "outline"}
          size="icon-xs"
          onClick={handleToggle}
          aria-label={isPlaying ? "Stop" : "Play"}
        >
          {isPlaying ? <SquareIcon className="size-2.5" /> : <PlayIcon className="size-2.5" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={handleRemove} aria-label="Remove">
          <XIcon className="size-2.5" />
        </Button>
      </div>

      <div className="flex items-center gap-3 pl-5.5">
        <label className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <Switch
            checked={item.loop}
            onCheckedChange={(checked) =>
              useMediaStore.getState().updateItem(item.id, { loop: checked })
            }
          />
          Loop
        </label>

        <div className="flex flex-1 items-center gap-2">
          <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground">
            Vol {Math.round(item.volume * 100)}%
          </span>
          <Slider
            value={[item.volume * 100]}
            min={0}
            max={100}
            step={1}
            onValueChange={([value]) =>
              useMediaStore.getState().updateItem(item.id, { volume: value / 100 })
            }
          />
        </div>
      </div>
    </div>
  )
}

export function MediaPanel() {
  const items = useMediaStore((s) => s.items)
  const playingId = useMediaStore((s) => s.playingId)

  return (
    <div
      data-slot="media-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Media loops">
        <Button
          variant="outline"
          size="xs"
          onClick={() => void useMediaStore.getState().addItem()}
        >
          <PlusIcon className="size-3" />
          Add video
        </Button>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5 p-1.5">
          {items.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              Add a short video loop (H.264 MP4) for pre-service announcements
            </p>
          )}
          {items.map((item) => (
            <MediaItemRow key={item.id} item={item} isPlaying={item.id === playingId} />
          ))}
        </div>
      </div>
    </div>
  )
}
