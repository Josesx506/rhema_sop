/**
 * Pure functions that expand a Song's arrangement into presentable blocks.
 *
 * Expansion pipeline:
 *  1. Resolve the playback order (arrangement, or authored section order
 *     when the arrangement is empty).
 *  2. Run-length encode CONSECUTIVE occurrences of the same section id.
 *  3. For each run, split the section's lines into parts when they exceed
 *     `linesPerBlock` (0/undefined = never split).
 *  4. Emit one block per part. When a run has more than one occurrence,
 *     every part in that run carries a "(xN)" suffix and `repeatCount`
 *     reflects the whole run — the repeats collapse into the same parts
 *     rather than being repeated N times over.
 */
import type { Song, SongBlock, SongSection } from "@/types/songs"

interface SectionRun {
  sectionId: string
  count: number
}

/** Run-length encode consecutive equal ids. */
function runLengthEncode(ids: string[]): SectionRun[] {
  const runs: SectionRun[] = []
  for (const id of ids) {
    const last = runs[runs.length - 1]
    if (last && last.sectionId === id) {
      last.count += 1
    } else {
      runs.push({ sectionId: id, count: 1 })
    }
  }
  return runs
}

/** Split lines into chunks of at most `linesPerBlock`. 0/undefined = one chunk. */
function splitLines(lines: string[], linesPerBlock: number | undefined): string[][] {
  if (!linesPerBlock || linesPerBlock <= 0 || lines.length <= linesPerBlock) {
    return [lines]
  }
  const parts: string[][] = []
  for (let i = 0; i < lines.length; i += linesPerBlock) {
    parts.push(lines.slice(i, i + linesPerBlock))
  }
  return parts
}

function buildLabel(section: SongSection, partIndex: number, partCount: number, repeatCount: number): string {
  const pieces = [section.label]
  if (partCount > 1) pieces.push(`(${partIndex + 1}/${partCount})`)
  if (repeatCount > 1) pieces.push(`(x${repeatCount})`)
  return pieces.join(" ")
}

/**
 * Expand a song's arrangement into an ordered list of presentable blocks.
 * Pure — does not mutate the song and generates fresh block ids each call.
 */
export function expandSong(song: Song): SongBlock[] {
  const orderedIds = song.arrangement.length > 0 ? song.arrangement : song.sections.map((s) => s.id)
  const sectionsById = new Map(song.sections.map((s) => [s.id, s]))
  const runs = runLengthEncode(orderedIds)

  const blocks: SongBlock[] = []
  for (const run of runs) {
    const section = sectionsById.get(run.sectionId)
    if (!section) continue // arrangement references a section that no longer exists

    const parts = splitLines(section.lines, song.linesPerBlock)
    for (let i = 0; i < parts.length; i++) {
      blocks.push({
        id: crypto.randomUUID(),
        songId: song.id,
        sectionId: section.id,
        label: buildLabel(section, i, parts.length, run.count),
        lines: parts[i],
        repeatCount: run.count,
      })
    }
  }
  return blocks
}
