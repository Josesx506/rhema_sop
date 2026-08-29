/**
 * Pure parsers that turn imported lyric text/XML into a shape the song
 * editor can prefill sections from. None of these touch the catalog store —
 * they either return a parsed result or throw a descriptive Error.
 */

export interface ParsedSection {
  label: string
  lines: string[]
}

export interface ParsedSong {
  title: string
  artist: string
  sections: ParsedSection[]
}

// ── Shared section-name normalisation (OpenLyrics verse names / OpenSong
//    [markers] use the same shorthand: v1, c, c1, b1, p, t, i, o, e...) ──

const TYPE_LABELS: Record<string, string> = {
  v: "Verse",
  verse: "Verse",
  c: "Chorus",
  chorus: "Chorus",
  b: "Bridge",
  bridge: "Bridge",
  p: "Pre-Chorus",
  prechorus: "Pre-Chorus",
  t: "Tag",
  tag: "Tag",
  i: "Intro",
  intro: "Intro",
  o: "Outro",
  outro: "Outro",
  e: "Ending",
  ending: "Ending",
  coda: "Ending",
}

/**
 * Maps a shorthand section code (OpenLyrics `name` attribute, OpenSong
 * `[marker]` contents) to a display label. Verses always keep a number
 * (default 1); other types only show a number above 1, so `c`/`c1` and
 * `b1` collapse to plain "Chorus"/"Bridge".
 */
function sectionLabelFromCode(code: string): string {
  const match = code.trim().match(/^([a-zA-Z-]+)\s*(\d*)$/)
  if (!match) return code.trim()
  const [, rawType, rawNum] = match
  const key = rawType.toLowerCase().replace(/-/g, "")
  const base = TYPE_LABELS[key] ?? rawType.charAt(0).toUpperCase() + rawType.slice(1)
  const num = rawNum ? parseInt(rawNum, 10) : undefined

  if (key === "v" || key === "verse") return `${base} ${num ?? 1}`
  if (num !== undefined && num > 1) return `${base} ${num}`
  return base
}

function parseXmlDocument(xml: string, formatName: string): Document {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, "application/xml")
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Invalid ${formatName} file: could not parse XML`)
  }
  return doc
}

// ── Plain text ──

const SECTION_LABEL_RE =
  /^\[?\s*(verse|chorus|bridge|pre-?chorus|tag|intro|outro|ending)\s*(\d*)\s*\]?$/i

function normalizePlainTextLabel(type: string, num: string): string {
  const key = type.toLowerCase().replace(/-/g, "").replace(/\s+/g, "")
  const base = TYPE_LABELS[key] ?? type
  return num ? `${base} ${num}` : base
}

/**
 * Parses freeform pasted lyrics: paragraphs separated by blank lines, with
 * an optional section-label line (e.g. "Verse 1", "[Chorus]") leading each
 * paragraph. Paragraphs without a recognised label become "Verse 1",
 * "Verse 2", ... in order.
 */
export function parsePlainText(text: string): ParsedSong {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("No lyrics provided")
  }

  const paragraphs = trimmed.split(/\n\s*\n+/)
  const sections: ParsedSection[] = []
  let unlabeledCount = 0

  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) continue

    const match = lines[0].match(SECTION_LABEL_RE)
    if (match) {
      const label = normalizePlainTextLabel(match[1], match[2])
      sections.push({ label, lines: lines.slice(1) })
    } else {
      unlabeledCount += 1
      sections.push({ label: `Verse ${unlabeledCount}`, lines })
    }
  }

  if (sections.length === 0) {
    throw new Error("No lyric sections found")
  }

  return { title: "", artist: "", sections }
}

// ── OpenLyrics XML ──

/**
 * Splits an OpenLyrics <lines> element's content into lines. Supports both
 * the spec's plain-text-with-<br/> form and the equally common variant that
 * nests one <line> element per lyric line.
 */
function extractOpenLyricsLines(linesEl: Element): string[] {
  const lineEls = Array.from(linesEl.children).filter((el) => el.tagName.toLowerCase() === "line")
  if (lineEls.length > 0) {
    return lineEls.map((el) => el.textContent?.trim() ?? "").filter((line) => line.length > 0)
  }

  const parts: string[] = []
  let current = ""
  linesEl.childNodes.forEach((node) => {
    if (node.nodeType === node.TEXT_NODE) {
      current += node.textContent ?? ""
    } else if (node.nodeType === node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === "br") {
      parts.push(current)
      current = ""
    } else {
      current += node.textContent ?? ""
    }
  })
  parts.push(current)
  return parts.map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * Parses OpenLyrics XML (<song><properties>...<lyrics><verse name="v1">).
 */
export function parseOpenLyrics(xml: string): ParsedSong {
  const doc = parseXmlDocument(xml, "OpenLyrics")

  const titleEl = doc.getElementsByTagName("title")[0]
  const authorEl = doc.getElementsByTagName("author")[0]
  const title = titleEl?.textContent?.trim() ?? ""
  const artist = authorEl?.textContent?.trim() ?? ""

  const verseEls = Array.from(doc.getElementsByTagName("verse"))
  if (verseEls.length === 0) {
    throw new Error("Invalid OpenLyrics file: no <verse> elements found")
  }

  const sections: ParsedSection[] = []
  for (const verseEl of verseEls) {
    const name = verseEl.getAttribute("name") ?? "v"
    const label = sectionLabelFromCode(name)
    const linesEls = Array.from(verseEl.getElementsByTagName("lines"))
    const lines = linesEls.flatMap((el) => extractOpenLyricsLines(el))
    sections.push({ label, lines })
  }

  return { title, artist, sections }
}

// ── OpenSong ──

/**
 * Parses OpenSong XML (<song><title><author><lyrics>...</lyrics>), where
 * lyrics is plain text with [V1]/[C]-style section markers. Lines starting
 * with "." are chord lines and are ignored.
 */
export function parseOpenSong(xml: string): ParsedSong {
  const doc = parseXmlDocument(xml, "OpenSong")

  const title = doc.getElementsByTagName("title")[0]?.textContent?.trim() ?? ""
  const artist = doc.getElementsByTagName("author")[0]?.textContent?.trim() ?? ""

  const lyricsEl = doc.getElementsByTagName("lyrics")[0]
  if (!lyricsEl) {
    throw new Error("Invalid OpenSong file: missing <lyrics> element")
  }

  const rawLines = (lyricsEl.textContent ?? "").split(/\r?\n/)
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null
  let unlabeledCount = 0

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/^\s+/, "").trimEnd()
    if (line.length === 0) continue
    if (line.startsWith(".")) continue // chord line

    const markerMatch = line.match(/^\[(.+?)\]$/)
    if (markerMatch) {
      current = { label: sectionLabelFromCode(markerMatch[1]), lines: [] }
      sections.push(current)
      continue
    }

    if (!current) {
      unlabeledCount += 1
      current = { label: `Verse ${unlabeledCount}`, lines: [] }
      sections.push(current)
    }
    current.lines.push(line)
  }

  if (sections.length === 0) {
    throw new Error("No lyric content found in OpenSong file")
  }

  return { title, artist, sections }
}
