/**
 * Validate drafted songs and append them to the local song catalog.
 *
 *   bun .claude/skills/format-songs/add-songs.ts <draft.json> [--write] [--allow-duplicate] [--catalog <path>]
 *
 * Draft format: an array of { title, artist, ccliNumber?, sections: [{ label, lines }], arrangement: [label] }.
 * Without --write this only validates and previews.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

interface DraftSection {
  label: string
  lines: string[]
}

interface DraftSong {
  title: string
  artist?: string
  ccliNumber?: string
  sections: DraftSection[]
  arrangement: string[]
}

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const draftPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--catalog")
if (!draftPath) {
  console.error("usage: add-songs.ts <draft.json> [--write] [--allow-duplicate] [--catalog <path>]")
  process.exit(2)
}

const repoRoot = resolve(import.meta.dir, "../../..")
const catalogPath = resolve(option("--catalog") ?? join(repoRoot, "local/song-catalog.json"))

const drafts: DraftSong[] = JSON.parse(readFileSync(draftPath, "utf8"))
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))
if (catalog.format !== "rhema-song-catalog" || !Array.isArray(catalog.songs)) {
  console.error(`${catalogPath} is not a Rhema song catalog export`)
  process.exit(1)
}

const key = (title: string, artist = "") => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`
const existing = new Set(catalog.songs.map((s: { title: string; artist: string }) => key(s.title, s.artist)))

const errors: string[] = []
const now = Date.now()
const songs = drafts.map((draft) => {
  const where = `"${draft.title}"`
  if (!draft.title?.trim()) errors.push("song with empty title")
  if (existing.has(key(draft.title, draft.artist)) && !flag("--allow-duplicate")) {
    errors.push(`${where}: already in the catalog (use --allow-duplicate to add anyway)`)
  }

  const idByLabel = new Map<string, string>()
  const sections = draft.sections.map((section) => {
    if (idByLabel.has(section.label)) errors.push(`${where}: duplicate section label "${section.label}"`)
    if (!section.lines.length) errors.push(`${where}: "${section.label}" has no lines`)
    if (section.lines.some((line) => !line.trim())) errors.push(`${where}: "${section.label}" has an empty line`)
    if (section.lines.length > 6) console.warn(`warning: ${where}: "${section.label}" has ${section.lines.length} lines`)
    const id = crypto.randomUUID()
    idByLabel.set(section.label, id)
    return { id, label: section.label, lines: section.lines.map((line) => line.trim()) }
  })

  for (const label of draft.arrangement) {
    if (!idByLabel.has(label)) errors.push(`${where}: arrangement references unknown section "${label}"`)
  }
  for (const label of idByLabel.keys()) {
    if (!draft.arrangement.includes(label)) errors.push(`${where}: section "${label}" is never used in the arrangement`)
  }

  return {
    title: draft.title.trim(),
    artist: (draft.artist ?? "").trim(),
    ...(draft.ccliNumber ? { ccliNumber: draft.ccliNumber } : {}),
    sections,
    arrangement: draft.arrangement.map((label) => idByLabel.get(label) ?? label),
    linesPerBlock: 0,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
})

// Preview the arrangement as the setlist shows it: consecutive repeats collapse to "Label (xN)".
for (const [i, draft] of drafts.entries()) {
  const collapsed: string[] = []
  for (const label of draft.arrangement) {
    const last = collapsed.at(-1)
    const match = last?.match(/^(.*?)(?: \(x(\d+)\))?$/)
    if (match && match[1] === label) collapsed[collapsed.length - 1] = `${label} (x${Number(match[2] ?? 1) + 1})`
    else collapsed.push(label)
  }
  console.log(`${draft.title} — ${draft.artist ?? ""}`)
  console.log(`  ${songs[i].sections.length} sections; ${collapsed.join(" → ")}`)
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n- ${errors.join("\n- ")}`)
  process.exit(1)
}

if (!flag("--write")) {
  console.log("\nValid. Re-run with --write to append to the catalog.")
  process.exit(0)
}

const stamp = new Date(now).toISOString().replace(/[:.]/g, "-")
const backupPath = catalogPath.replace(/\.json$/, `.backup-${stamp}.json`)
copyFileSync(catalogPath, backupPath)

catalog.songs.push(...songs)
catalog.exportedAt = now
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)

const importPath = join(dirname(catalogPath), `new-songs-${stamp}.json`)
writeFileSync(
  importPath,
  `${JSON.stringify({ format: "rhema-song-catalog", version: catalog.version ?? 1, exportedAt: now, songs }, null, 2)}\n`,
)

console.log(`\nAdded ${songs.length} song(s) to ${catalogPath}`)
console.log(`Backup:         ${backupPath}`)
console.log(`Import in app:  ${importPath}`)
