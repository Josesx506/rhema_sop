import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
import { PanelHeader } from "@/components/ui/panel-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  DownloadIcon,
  ListPlusIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { hydrateSongCatalog, matchesSearch, useSongStore } from "@/stores/song-store"
import { exportCatalog, importCatalogFile } from "@/lib/songs/catalog-file"
import { parseOpenLyrics, parseOpenSong, parsePlainText, type ParsedSong } from "@/lib/songs/import-parsers"
import { SongEditorDialog } from "@/components/songs/song-editor-dialog"
import type { Song } from "@/types/songs"

async function readXmlFile(extensionLabel: string): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    filters: [{ name: extensionLabel, extensions: ["xml"] }],
  })
  if (!selected) return null
  const path = typeof selected === "string" ? selected : selected
  const bytes = await readFile(path)
  return new TextDecoder().decode(bytes)
}

function SongRow({
  song,
  confirmingDelete,
  onAddToSetlist,
  onEdit,
  onDeleteClick,
}: {
  song: Song
  confirmingDelete: boolean
  onAddToSetlist: () => void
  onEdit: () => void
  onDeleteClick: () => void
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{song.title}</span>
          {song.ccliNumber && (
            <Badge variant="outline" className="shrink-0 text-[0.5rem]">
              CCLI {song.ccliNumber}
            </Badge>
          )}
        </div>
        {song.artist && <p className="truncate text-xs text-muted-foreground">{song.artist}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon-xs" title="Add to setlist" onClick={onAddToSetlist}>
          <ListPlusIcon className="size-3.5 text-primary" />
        </Button>
        <Button variant="ghost" size="icon-xs" title="Edit" onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title={confirmingDelete ? "Click again to confirm" : "Delete"}
          className={cn(confirmingDelete && "text-destructive")}
          onClick={onDeleteClick}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function SongCatalogPanel() {
  const songs = useSongStore((s) => s.songs)
  const searchQuery = useSongStore((s) => s.searchQuery)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSong, setEditingSong] = useState<Song | null>(null)
  const [editorInitial, setEditorInitial] = useState<ParsedSong | undefined>(undefined)

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState("")

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void hydrateSongCatalog()
  }, [])

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const filtered = songs.filter((song) => matchesSearch(song, searchQuery))

  const openEditorForNewSong = () => {
    setEditingSong(null)
    setEditorInitial(undefined)
    setEditorOpen(true)
  }

  const openEditorFromParsed = (parsed: ParsedSong) => {
    setEditingSong(null)
    setEditorInitial(parsed)
    setEditorOpen(true)
  }

  const handlePasteImport = () => {
    try {
      const parsed = parsePlainText(pasteText)
      setPasteOpen(false)
      setPasteText("")
      openEditorFromParsed(parsed)
    } catch (err) {
      toast.error("Could not parse lyrics", { description: String(err instanceof Error ? err.message : err) })
    }
  }

  const handleFileImport = (kind: "openlyrics" | "opensong") => {
    void (async () => {
      try {
        const xml = await readXmlFile(kind === "openlyrics" ? "OpenLyrics XML" : "OpenSong XML")
        if (!xml) return
        const parsed = kind === "openlyrics" ? parseOpenLyrics(xml) : parseOpenSong(xml)
        openEditorFromParsed(parsed)
      } catch (err) {
        toast.error("Import failed", { description: String(err instanceof Error ? err.message : err) })
      }
    })()
  }

  const handleCatalogImport = () => {
    void (async () => {
      try {
        const imported = await importCatalogFile()
        if (!imported) return
        useSongStore.getState().importSongs(imported)
        toast.success(`Imported ${imported.length} song${imported.length === 1 ? "" : "s"}`)
      } catch (err) {
        toast.error("Catalog import failed", { description: String(err instanceof Error ? err.message : err) })
      }
    })()
  }

  const handleExport = () => {
    void (async () => {
      try {
        await exportCatalog(useSongStore.getState().songs)
      } catch (err) {
        toast.error("Export failed", { description: String(err instanceof Error ? err.message : err) })
      }
    })()
  }

  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      setConfirmDeleteId(null)
      useSongStore.getState().deleteSong(id)
      return
    }
    setConfirmDeleteId(id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000)
  }

  return (
    <div
      data-slot="song-catalog-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Song catalog">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={openEditorForNewSong}>
            <PlusIcon className="size-3" />
            Add song
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs">
                <UploadIcon className="size-3" />
                Import
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setPasteOpen(true)}>Paste lyrics</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileImport("openlyrics")}>
                OpenLyrics XML file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileImport("opensong")}>OpenSong file</DropdownMenuItem>
              <DropdownMenuItem onClick={handleCatalogImport}>Catalog JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="xs" onClick={handleExport}>
            <DownloadIcon className="size-3" />
            Export
          </Button>
        </div>
      </PanelHeader>

      <div className="border-b border-border p-2">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search songs..."
            value={searchQuery}
            onChange={(e) => useSongStore.getState().setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-1.5">
          {filtered.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {songs.length === 0 ? "No songs yet — add one to get started" : "No songs match your search"}
            </p>
          )}
          {filtered.map((song) => (
            <SongRow
              key={song.id}
              song={song}
              confirmingDelete={confirmDeleteId === song.id}
              onAddToSetlist={() => useSongStore.getState().addSongToSetlist(song.id)}
              onEdit={() => {
                setEditingSong(song)
                setEditorInitial(undefined)
                setEditorOpen(true)
              }}
              onDeleteClick={() => handleDeleteClick(song.id)}
            />
          ))}
        </div>
      </ScrollArea>

      <SongEditorDialog open={editorOpen} onOpenChange={setEditorOpen} song={editingSong} initial={editorInitial} />

      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Paste lyrics</DialogTitle>
            <DialogDescription>
              Separate sections with a blank line. A leading label line (e.g. "Verse 1", "[Chorus]") starts a
              labeled section — unlabeled paragraphs become Verse 1, Verse 2, ...
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"Verse 1\nAmazing grace, how sweet the sound\n\nChorus\n..."}
            className="min-h-48"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handlePasteImport} disabled={!pasteText.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
