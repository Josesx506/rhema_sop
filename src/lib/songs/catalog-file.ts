/** Import/export the song catalog as a portable JSON file, mirroring the
 * theme-designer file dialog conventions (native save/open dialogs + the fs
 * plugin). */
import { open, save } from "@tauri-apps/plugin-dialog"
import { readFile, writeTextFile } from "@tauri-apps/plugin-fs"
import type { Song, SongCatalogExport } from "@/types/songs"

const CATALOG_FORMAT = "rhema-song-catalog" as const

/** Exports the given songs as a JSON file via a native save dialog. */
export async function exportCatalog(songs: Song[]): Promise<void> {
  const path = await save({
    defaultPath: "song-catalog.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  })
  if (!path) return

  const payload: SongCatalogExport = {
    format: CATALOG_FORMAT,
    version: 1,
    exportedAt: Date.now(),
    songs,
  }
  await writeTextFile(path, JSON.stringify(payload, null, 2))
}

/**
 * Opens a native file dialog, parses + validates a catalog export, and
 * returns songs with fresh ids so importing never collides with (or
 * overwrites) anything already in the catalog. Returns null if the user
 * cancels the dialog.
 */
export async function importCatalogFile(): Promise<Song[] | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Song catalog JSON", extensions: ["json"] }],
  })
  if (!selected) return null

  const path = typeof selected === "string" ? selected : selected
  const bytes = await readFile(path)
  const text = new TextDecoder().decode(bytes)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Invalid catalog file: not valid JSON")
  }

  const data = parsed as Partial<SongCatalogExport>
  if (data.format !== CATALOG_FORMAT || !Array.isArray(data.songs)) {
    throw new Error("Invalid catalog file: not a Rhema song catalog export")
  }

  return data.songs.map((song) => cloneSongWithFreshIds(song))
}

/**
 * Copy a song with a fresh song id and fresh section ids (the arrangement is
 * remapped to match), so importing it can never collide with — or silently
 * overwrite — anything already in the catalog.
 */
export function cloneSongWithFreshIds(song: Song, now = Date.now()): Song {
  const sectionIdMap = new Map<string, string>()
  const sections = song.sections.map((section) => {
    const newId = crypto.randomUUID()
    sectionIdMap.set(section.id, newId)
    return { ...section, id: newId }
  })
  return {
    ...song,
    id: crypto.randomUUID(),
    sections,
    arrangement: song.arrangement.map((id) => sectionIdMap.get(id) ?? id),
    createdAt: now,
    updatedAt: now,
  }
}
