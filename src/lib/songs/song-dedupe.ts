/**
 * Fork: one shared answer to "is this the same song?", used by catalog
 * imports and by setlist loading so both agree.
 *
 * Ids cannot be that answer: every import path re-issues fresh uuids (see
 * cloneSongWithFreshIds), so re-importing the same file would otherwise pile
 * up copies. Identity is therefore title + artist, normalized — the only two
 * fields every source format (catalog JSON, OpenLyrics, OpenSong,
 * ProPresenter, setlist files) reliably carries.
 */
import type { Song } from "@/types/songs"

/** Curly apostrophes are everywhere in the ProPresenter catalog, so
 * "Jesus’ Name" and "Jesus' Name" must key the same. */
const APOSTROPHES = /[‘’ʼ]/g

function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * Normalized identity for a song: `"<title> <artist>"`. Deliberately plain —
 * no article stripping or punctuation removal — so an operator can predict
 * which two songs will be treated as one.
 */
export function songIdentityKey(song: Pick<Song, "title" | "artist">): string {
  return `${normalize(song.title)} ${normalize(song.artist ?? "")}`
}

export interface SongDedupeResult {
  /** Incoming songs not already present, in their original order. */
  added: Song[]
  /** Incoming songs dropped as repeats, in their original order. */
  duplicates: Song[]
}

/**
 * Split `incoming` into the songs worth adding and the repeats. A song is a
 * repeat when its identity matches something in `existing` or an earlier
 * entry of `incoming` itself (a file with internal repeats collapses too).
 * Pure: no ids are generated and neither argument is mutated.
 */
export function dedupeIncomingSongs(incoming: Song[], existing: Song[]): SongDedupeResult {
  const seen = new Set(existing.map(songIdentityKey))
  const added: Song[] = []
  const duplicates: Song[] = []
  for (const song of incoming) {
    const key = songIdentityKey(song)
    if (seen.has(key)) {
      duplicates.push(song)
      continue
    }
    seen.add(key)
    added.push(song)
  }
  return { added, duplicates }
}
