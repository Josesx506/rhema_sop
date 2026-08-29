/**
 * Song catalog & setlist types (fork feature — see todo.md "Songs feature").
 * Fork-owned file: upstream never touches this.
 */

/** A named lyric section as authored (verse, chorus, bridge, ...). */
export interface SongSection {
  /** Stable id within the song (e.g. crypto.randomUUID()). */
  id: string
  /** Display label, e.g. "Verse 1", "Chorus", "Bridge". */
  label: string
  /** Lyric lines, one string per rendered line. */
  lines: string[]
}

/** A song as stored in the catalog (persisted). */
export interface Song {
  id: string
  title: string
  /** Artist / author, free text. Empty string when unknown/traditional. */
  artist: string
  /** Optional CCLI song number for license display. */
  ccliNumber?: string
  sections: SongSection[]
  /**
   * Playback order as section ids, e.g. [v1, c, v2, c, b, c].
   * Empty array = present sections in authored order.
   */
  arrangement: string[]
  /**
   * Max lyric lines per presented block before auto-splitting.
   * 0 or undefined = never split (whole section is one block).
   */
  linesPerBlock?: number
  createdAt: number
  updatedAt: number
}

/**
 * One presentable block, produced by expanding a song's arrangement
 * (with auto-split and consecutive-repeat collapse applied).
 */
export interface SongBlock {
  /** Unique per setlist entry occurrence. */
  id: string
  songId: string
  sectionId: string
  /** e.g. "Chorus", "Chorus (x2)", "Verse 1 (2/3)" for split parts. */
  label: string
  lines: string[]
  /** >1 when consecutive repeats were collapsed into this block. */
  repeatCount: number
}

/** A song added to the running setlist, with its expanded blocks. */
export interface SetlistEntry {
  /** Unique per setlist addition (same song can be added twice). */
  id: string
  songId: string
  title: string
  blocks: SongBlock[]
}

/** Portable catalog export format (JSON file moved between machines). */
export interface SongCatalogExport {
  format: "rhema-song-catalog"
  version: 1
  exportedAt: number
  songs: Song[]
}
