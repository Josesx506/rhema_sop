import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSongStore } from "@/stores/song-store"
import type { ParsedSong } from "@/lib/songs/import-parsers"
import type { Song, SongSection } from "@/types/songs"

interface EditableSection {
  id: string
  label: string
  linesText: string
}

export interface SongEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, the dialog edits this song. Otherwise it creates a new one. */
  song?: Song | null
  /** Prefill for create mode (e.g. from a "Paste lyrics" import). Ignored when editing. */
  initial?: ParsedSong
}

function move<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function SongEditorDialog({ open, onOpenChange, song, initial }: SongEditorDialogProps) {
  const [title, setTitle] = useState("")
  const [artist, setArtist] = useState("")
  const [ccliNumber, setCcliNumber] = useState("")
  const [linesPerBlock, setLinesPerBlock] = useState(0)
  const [sections, setSections] = useState<EditableSection[]>([])
  const [arrangement, setArrangement] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    if (song) {
      setTitle(song.title)
      setArtist(song.artist)
      setCcliNumber(song.ccliNumber ?? "")
      setLinesPerBlock(song.linesPerBlock ?? 0)
      setSections(song.sections.map((s) => ({ id: s.id, label: s.label, linesText: s.lines.join("\n") })))
      setArrangement(song.arrangement.length > 0 ? song.arrangement : song.sections.map((s) => s.id))
    } else {
      setTitle(initial?.title ?? "")
      setArtist(initial?.artist ?? "")
      setCcliNumber("")
      setLinesPerBlock(0)
      const seeded: EditableSection[] = (initial?.sections ?? []).map((s) => ({
        id: crypto.randomUUID(),
        label: s.label,
        linesText: s.lines.join("\n"),
      }))
      setSections(seeded)
      setArrangement(seeded.map((s) => s.id))
    }
  }, [open, song, initial])

  const addSection = () => {
    const id = crypto.randomUUID()
    setSections((prev) => [...prev, { id, label: `Section ${prev.length + 1}`, linesText: "" }])
  }
  const removeSection = (id: string) => {
    setSections((prev) => prev.filter((s) => s.id !== id))
    setArrangement((prev) => prev.filter((sid) => sid !== id))
  }
  const renameSection = (id: string, label: string) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)))
  }
  const setSectionLines = (id: string, linesText: string) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, linesText } : s)))
  }
  const moveSection = (index: number, dir: -1 | 1) => {
    setSections((prev) => move(prev, index, dir))
  }

  const addToArrangement = (sectionId: string) => {
    setArrangement((prev) => [...prev, sectionId])
  }
  const removeFromArrangement = (index: number) => {
    setArrangement((prev) => prev.filter((_, i) => i !== index))
  }
  const moveArrangement = (index: number, dir: -1 | 1) => {
    setArrangement((prev) => move(prev, index, dir))
  }

  const canSave = title.trim().length > 0

  const handleSave = () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    const finalSections: SongSection[] = sections.map((s) => ({
      id: s.id,
      label: s.label.trim() || "Untitled",
      lines: s.linesText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    }))
    const validIds = new Set(finalSections.map((s) => s.id))
    const finalArrangement = arrangement.filter((id) => validIds.has(id))
    const trimmedCcli = ccliNumber.trim()

    const patch = {
      title: trimmedTitle,
      artist: artist.trim(),
      ccliNumber: trimmedCcli || undefined,
      sections: finalSections,
      arrangement: finalArrangement,
      linesPerBlock,
    }

    if (song) {
      useSongStore.getState().updateSong(song.id, patch)
    } else {
      useSongStore.getState().addSong(patch)
    }
    onOpenChange(false)
  }

  const sectionLabelById = new Map(sections.map((s) => [s.id, s.label]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{song ? "Edit song" : "Add song"}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song title" autoFocus />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Artist</label>
              <Input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist / author" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">CCLI number</label>
              <Input value={ccliNumber} onChange={(e) => setCcliNumber(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">
                Lines per block <span className="normal-case">(0 = never split)</span>
              </label>
              <Input
                type="number"
                min={0}
                value={linesPerBlock}
                onChange={(e) => setLinesPerBlock(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase">Sections</span>
              <Button variant="outline" size="xs" onClick={addSection}>
                <PlusIcon className="size-3" />
                Add section
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {sections.length === 0 && (
                <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                  No sections yet — add one to start writing lyrics.
                </p>
              )}
              {sections.map((section, index) => (
                <div key={section.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={section.label}
                      onChange={(e) => renameSection(section.id, e.target.value)}
                      className="h-7 flex-1 text-xs font-medium"
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === 0}
                      onClick={() => moveSection(index, -1)}
                    >
                      <ChevronUpIcon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === sections.length - 1}
                      onClick={() => moveSection(index, 1)}
                    >
                      <ChevronDownIcon className="size-3" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => removeSection(section.id)}>
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                  <Textarea
                    value={section.linesText}
                    onChange={(e) => setSectionLines(section.id, e.target.value)}
                    placeholder="One lyric line per row"
                    className="min-h-20 text-sm"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase">Arrangement</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="xs" disabled={sections.length === 0}>
                    <PlusIcon className="size-3" />
                    Add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sections.map((s) => (
                    <DropdownMenuItem key={s.id} onClick={() => addToArrangement(s.id)}>
                      {s.label || "Untitled"}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {arrangement.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Empty = present sections in authored order.
                </p>
              )}
              {arrangement.map((sectionId, index) => (
                <div
                  key={`${sectionId}-${index}`}
                  className={cn(
                    "flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2.5 text-xs"
                  )}
                >
                  <span>{sectionLabelById.get(sectionId) ?? "Unknown"}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => moveArrangement(index, -1)}
                  >
                    <ChevronUpIcon className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={index === arrangement.length - 1}
                    onClick={() => moveArrangement(index, 1)}
                  >
                    <ChevronDownIcon className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeFromArrangement(index)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {song ? "Save changes" : "Add song"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
