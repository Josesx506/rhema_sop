import { useEffect } from "react"
import { toast } from "sonner"
import { PanelHeader } from "@/components/ui/panel-header"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  EllipsisVerticalIcon,
  XIcon,
} from "lucide-react"
import { useSongStore } from "@/stores/song-store"
import { exportSetlistFile, importSetlistFile } from "@/lib/songs/setlist-file"
import type { SetlistEntry, SongBlock } from "@/types/songs"

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

function BlockRow({
  block,
  isLive,
  isPreviewed,
  onPreview,
  onPresent,
}: {
  block: SongBlock
  isLive: boolean
  isPreviewed: boolean
  onPreview: () => void
  onPresent: () => void
}) {
  return (
    <div
      // Single click presents — same convention as Scripture-mode queue
      // rows, one click per block during a song. ⌥-click previews only
      // (arrow keys + Enter remain the keyboard preview path).
      onClick={(e) => (e.altKey ? onPreview() : onPresent())}
      title="Click to present · ⌥-click to preview"
      className={cn(
        "flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 transition-colors",
        // Live styling is dominant when a row is both previewed and live.
        isLive
          ? "border border-primary/30 bg-primary/10 ring-1 ring-primary/40"
          : isPreviewed
            ? "border border-sky-400/40 bg-sky-400/5"
            : "hover:bg-muted/50"
      )}
    >
      <span className="text-xs font-medium text-foreground">{block.label}</span>
      <span className="truncate text-[0.6875rem] text-muted-foreground">
        {block.lines[0] ?? "(no lyrics)"}
      </span>
    </div>
  )
}

function SetlistEntryGroup({
  entry,
  collapsed,
  isFirst,
  isLast,
  activeBlockId,
  previewBlockId,
  onToggleCollapsed,
  onMoveUp,
  onMoveDown,
  onPreview,
  onPresent,
  onRemove,
}: {
  entry: SetlistEntry
  collapsed: boolean
  isFirst: boolean
  isLast: boolean
  activeBlockId: string | null
  previewBlockId: string | null
  onToggleCollapsed: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onPreview: (blockId: string) => void
  onPresent: (blockId: string) => void
  onRemove: () => void
}) {
  const containsLive = entry.blocks.some((b) => b.id === activeBlockId)
  return (
    <div className="flex flex-col gap-0.5">
      <div className="group flex items-center gap-1 px-1 pt-2 pb-1">
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand song" : "Collapse song"}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[0.6875rem] font-semibold tracking-wide uppercase",
              // Keep the on-air song findable while its rows are hidden.
              collapsed && containsLive ? "text-primary" : "text-muted-foreground"
            )}
          >
            {entry.title}
          </span>
          {collapsed && (
            <span className="shrink-0 text-[0.625rem] text-muted-foreground/70">
              {entry.blocks.length}
            </span>
          )}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Move song up"
          disabled={isFirst}
          onClick={onMoveUp}
        >
          <ArrowUpIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Move song down"
          disabled={isLast}
          onClick={onMoveDown}
        >
          <ArrowDownIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Remove song"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      {!collapsed &&
        entry.blocks.map((block) => (
          <BlockRow
            key={block.id}
            block={block}
            isLive={block.id === activeBlockId}
            isPreviewed={block.id === previewBlockId}
            onPreview={() => onPreview(block.id)}
            onPresent={() => onPresent(block.id)}
          />
        ))}
    </div>
  )
}

export function SetlistPanel() {
  const setlist = useSongStore((s) => s.setlist)
  const activeBlockId = useSongStore((s) => s.activeBlockId)
  const previewBlockId = useSongStore((s) => s.previewBlockId)
  const collapsedEntryIds = useSongStore((s) => s.collapsedEntryIds)
  const songs = useSongStore((s) => s.songs)

  const activeEntry = setlist.find((e) => e.blocks.some((b) => b.id === activeBlockId))
  const activeSong = activeEntry ? songs.find((s) => s.id === activeEntry.songId) : undefined
  const allowDuplicates = useSongStore((s) => s.allowSetlistDuplicates)
  const allCollapsed = setlist.length > 0 && setlist.every((e) => collapsedEntryIds[e.id])

  const handleSaveSetlist = () => {
    void (async () => {
      try {
        const { setlist: current, songs: catalog } = useSongStore.getState()
        if (await exportSetlistFile(current, catalog)) {
          toast.success(`Saved setlist (${current.length} song${current.length === 1 ? "" : "s"})`)
        }
      } catch (err) {
        toast.error("Could not save setlist", {
          description: String(err instanceof Error ? err.message : err),
        })
      }
    })()
  }

  const handleOpenSetlist = () => {
    void (async () => {
      try {
        const payload = await importSetlistFile()
        if (!payload) return
        const { loaded, added, missing } = useSongStore.getState().loadSetlist(payload)
        const notes: string[] = []
        if (added > 0) notes.push(`${added} song${added === 1 ? "" : "s"} added to the catalog`)
        if (missing.length > 0) notes.push(`skipped ${missing.join(", ")}`)
        toast.success(`Loaded setlist (${loaded} song${loaded === 1 ? "" : "s"})`, {
          description: notes.length ? notes.join(" · ") : undefined,
        })
      } catch (err) {
        toast.error("Could not open setlist", {
          description: String(err instanceof Error ? err.message : err),
        })
      }
    })()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault()
        useSongStore.getState().previewNext()
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault()
        useSongStore.getState().previewPrev()
      } else if (e.key === "Enter") {
        e.preventDefault()
        useSongStore.getState().presentPreviewed()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [])

  return (
    <div
      data-slot="setlist-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Setlist">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            title={allCollapsed ? "Expand all songs" : "Collapse all songs"}
            disabled={setlist.length === 0}
            onClick={() => useSongStore.getState().setAllEntriesCollapsed(!allCollapsed)}
          >
            {allCollapsed ? (
              <ChevronsUpDownIcon className="size-3.5" />
            ) : (
              <ChevronsDownUpIcon className="size-3.5" />
            )}
          </Button>
          <label
            className="mr-1 flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wider text-muted-foreground"
            title="When off, each song can appear only once in the setlist"
          >
            Repeats
            <Switch
              checked={allowDuplicates}
              onCheckedChange={(checked) =>
                useSongStore.getState().setAllowSetlistDuplicates(checked)
              }
            />
          </label>
          <Button variant="ghost" size="icon-xs" title="Previous block" onClick={() => useSongStore.getState().prevBlock()}>
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="Next block" onClick={() => useSongStore.getState().nextBlock()}>
            <ChevronRightIcon className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" title="Setlist file">
                <EllipsisVerticalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={handleSaveSetlist} disabled={setlist.length === 0}>
                Save setlist…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenSetlist}>Open setlist…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={setlist.length === 0}
                onClick={() => useSongStore.getState().clearSetlist()}
              >
                Clear setlist
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PanelHeader>

      {activeSong?.ccliNumber && (
        <div className="border-b border-border px-3 py-1.5 text-[0.625rem] text-muted-foreground">
          CCLI # {activeSong.ccliNumber}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:w-full">
        <div className="flex flex-col gap-1 p-1.5">
          {setlist.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              Add songs from the catalog to build a setlist
            </p>
          )}
          {setlist.map((entry, index) => (
            <SetlistEntryGroup
              key={entry.id}
              entry={entry}
              collapsed={!!collapsedEntryIds[entry.id]}
              isFirst={index === 0}
              isLast={index === setlist.length - 1}
              activeBlockId={activeBlockId}
              previewBlockId={previewBlockId}
              onToggleCollapsed={() => useSongStore.getState().toggleEntryCollapsed(entry.id)}
              onMoveUp={() => useSongStore.getState().reorderEntries(index, index - 1)}
              onMoveDown={() => useSongStore.getState().reorderEntries(index, index + 1)}
              onPreview={(blockId) => useSongStore.getState().previewBlock(entry.id, blockId)}
              onPresent={(blockId) => useSongStore.getState().presentBlock(entry.id, blockId)}
              onRemove={() => useSongStore.getState().removeEntry(entry.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
