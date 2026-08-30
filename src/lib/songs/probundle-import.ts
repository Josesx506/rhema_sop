/**
 * Import ProPresenter 7 `.proBundle` files into the song catalog. Ported
 * from the tested `data/convert-probundle.py` (fork-owned tool, see
 * todo.md) — see that file for the field-number notes this walker relies
 * on. `.pro` presentations are Protocol Buffers; we walk the wire format
 * schema-free (field numbers reverse-engineered from real exports):
 *   field 3  = presentation name
 *   field 12 = cue groups: {1: {1:{1:uuid}, 2:name}, 2: repeated {1: cue-uuid}}
 *   field 13 = cues (deck order): {1:{1:uuid}, ...nested slide text elements
 *              whose RTF blobs we collect recursively}
 *   field 14 = CCLI metadata: {1:author, 3:title, 5:year, 6:ccli#}
 * Slide text lives in RTF blobs; a small RTF-to-text decoder handles the
 * subset ProPresenter emits (cp1252 escapes, \uN unicode, \par/\line).
 */
import { unzipSync } from "fflate"
import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
import type { Song } from "@/types/songs"

// --- protobuf wire-format walker (schema-free) ------------------------------

type WireValue =
  | { wire: 0; value: number }
  | { wire: 1; value: Uint8Array }
  | { wire: 2; value: Uint8Array }
  | { wire: 5; value: Uint8Array }

type ProtoField = { field: number } & WireValue
type ProtoMessage = ProtoField[]

function readVarint(b: Uint8Array, i: number): [number, number] {
  // Accumulate with arithmetic (not bit-shifts) so values beyond 32 bits
  // (large CCLI numbers, timestamps) don't get truncated by JS's 32-bit
  // bitwise operators. Precision is exact up to 2^53, which comfortably
  // covers every field this walker reads.
  let r = 0
  let shift = 0
  for (;;) {
    if (i >= b.length) throw new Error("truncated varint")
    const x = b[i]
    i += 1
    r += (x & 0x7f) * 2 ** shift
    if (!(x & 0x80)) return [r, i]
    shift += 7
    if (shift > 63) throw new Error("varint too long")
  }
}

/** Parse bytes as a protobuf message; returns fields or null if the bytes
 * are not a plausible message. */
function parseMessage(b: Uint8Array): ProtoMessage | null {
  const out: ProtoMessage = []
  let i = 0
  try {
    while (i < b.length) {
      let tag: number
      ;[tag, i] = readVarint(b, i)
      const field = tag >>> 3
      const wire = tag & 7
      if (field === 0 || field > 10000) return null
      if (wire === 0) {
        let v: number
        ;[v, i] = readVarint(b, i)
        out.push({ field, wire: 0, value: v })
      } else if (wire === 1) {
        if (i + 8 > b.length) return null
        out.push({ field, wire: 1, value: b.subarray(i, i + 8) })
        i += 8
      } else if (wire === 5) {
        if (i + 4 > b.length) return null
        out.push({ field, wire: 5, value: b.subarray(i, i + 4) })
        i += 4
      } else if (wire === 2) {
        let len: number
        ;[len, i] = readVarint(b, i)
        if (i + len > b.length) return null
        out.push({ field, wire: 2, value: b.subarray(i, i + len) })
        i += len
      } else {
        return null
      }
    }
  } catch {
    return null
  }
  return out
}

/** All length-delimited values for a field number. */
function sub(msg: ProtoMessage, num: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const f of msg) {
    if (f.field === num && f.wire === 2) out.push(f.value)
  }
  return out
}

function ints(msg: ProtoMessage, num: number): number[] {
  const out: number[] = []
  for (const f of msg) {
    if (f.field === num && f.wire === 0) out.push(f.value)
  }
  return out
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

function firstStr(msg: ProtoMessage, num: number): string {
  for (const v of sub(msg, num)) {
    try {
      return utf8Decoder.decode(v)
    } catch {
      // not valid UTF-8; try the next candidate
    }
  }
  return ""
}

const RTF_PREFIX = new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66]) // "{\rtf"

function startsWithRtf(v: Uint8Array): boolean {
  if (v.length < RTF_PREFIX.length) return false
  for (let i = 0; i < RTF_PREFIX.length; i++) {
    if (v[i] !== RTF_PREFIX[i]) return false
  }
  return true
}

/** Recursively find RTF blobs anywhere inside a message. */
function collectRtf(b: Uint8Array, out: Uint8Array[], depth = 0): void {
  if (depth > 14) return
  const msg = parseMessage(b)
  if (msg === null) return
  for (const f of msg) {
    if (f.wire !== 2) continue
    if (startsWithRtf(f.value)) {
      out.push(f.value)
    } else {
      collectRtf(f.value, out, depth + 1)
    }
  }
}

// --- RTF -> plain text -------------------------------------------------------

const DEST_SKIP = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "expandedcolortbl",
  "themedata",
  "info",
  "pict",
])

// cp1252 differs from Latin-1 only in the 0x80-0x9F range.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
}

function cp1252Char(byte: number): string | null {
  // 0x81, 0x8d, 0x8f, 0x90, 0x9d are undefined in cp1252.
  if (byte >= 0x80 && byte <= 0x9f) {
    const cp = CP1252_HIGH[byte]
    return cp === undefined ? null : String.fromCodePoint(cp)
  }
  return String.fromCodePoint(byte)
}

function isAlpha(c: string): boolean {
  return /[a-zA-Z]/.test(c)
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9"
}

function rtfToText(data: Uint8Array): string {
  // RTF control words are ASCII; decode byte-for-byte (latin-1-equivalent)
  // so indices line up 1:1 with the source bytes, matching the Python.
  let s = ""
  for (let k = 0; k < data.length; k++) s += String.fromCharCode(data[k])

  const out: string[] = []
  const n = s.length
  let i = 0
  let skipDepth = 0
  let uc = 1

  while (i < n) {
    const c = s[i]
    if (c === "{") {
      i += 1
      if (skipDepth) skipDepth += 1
    } else if (c === "}") {
      i += 1
      if (skipDepth) skipDepth -= 1
    } else if (c === "\\") {
      i += 1
      if (i >= n) break
      const c2 = s[i]
      if (c2 === "'") {
        const h = s.slice(i + 1, i + 3)
        i += 3
        if (!skipDepth) {
          const byte = parseInt(h, 16)
          if (!Number.isNaN(byte)) {
            const ch = cp1252Char(byte)
            if (ch !== null) out.push(ch)
          }
        }
      } else if (c2 === "\\" || c2 === "{" || c2 === "}") {
        if (!skipDepth) out.push(c2)
        i += 1
      } else if (c2 === "\r" || c2 === "\n") {
        if (!skipDepth) out.push("\n")
        i += 1
      } else if (c2 === "*") {
        skipDepth = Math.max(skipDepth, 1)
        i += 1
      } else if (isAlpha(c2)) {
        let j = i
        while (j < n && isAlpha(s[j])) j += 1
        const word = s.slice(i, j)
        let k = j
        if (k < n && (s[k] === "-" || isDigit(s[k]))) {
          k += 1
          while (k < n && isDigit(s[k])) k += 1
        }
        const param = s.slice(j, k)
        if (k < n && s[k] === " ") k += 1
        i = k
        if (DEST_SKIP.has(word)) {
          skipDepth = Math.max(skipDepth, 1)
        } else if (skipDepth) {
          // inside a skipped destination; ignore
        } else if (word === "par" || word === "line") {
          out.push("\n")
        } else if (word === "tab") {
          out.push("\t")
        } else if (word === "uc") {
          uc = parseInt(param || "1", 10)
        } else if (word === "u") {
          let cp = parseInt(param, 10)
          if (cp < 0) cp += 65536
          out.push(String.fromCodePoint(cp))
          let skipn = uc
          while (skipn && i < n) {
            if (s[i] === "\\" && i + 1 < n && s[i + 1] === "'") {
              i += 4
            } else {
              i += 1
            }
            skipn -= 1
          }
        }
      } else {
        i += 1
      }
    } else {
      if (!skipDepth && c !== "\r" && c !== "\n" && c !== "\0") out.push(c)
      i += 1
    }
  }

  const text = out.join("")
  const lines = text.split("\n").map((ln) => ln.trim())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.join("\n")
}

// --- .pro -> Song -------------------------------------------------------------

const GENERIC_GROUP_NAMES = new Set(["", "group", "slide", "slides"])

/** All visible text on one cue's slide (multiple text boxes joined). */
function cueText(cueBytes: Uint8Array): string {
  const blobs: Uint8Array[] = []
  collectRtf(cueBytes, blobs)
  const parts: string[] = []
  for (const b of blobs) {
    const t = rtfToText(b)
    if (t && !parts.includes(t)) parts.push(t)
  }
  return parts.join("\n")
}

interface ConvertedSection {
  id: string
  label: string
  lines: string[]
}

interface ConvertResult {
  song: Song | null
  reason: string | null
}

function convertPro(data: Uint8Array, fallbackTitle: string): ConvertResult {
  const top = parseMessage(data)
  if (top === null) return { song: null, reason: "not a protobuf presentation" }

  const name = firstStr(top, 3).trim()

  // CCLI metadata (field 14)
  let artist = ""
  let ccliTitle = ""
  let ccliNumber: number | null = null
  for (const blob of sub(top, 14)) {
    const m = parseMessage(blob)
    if (m === null) continue
    artist = artist || firstStr(m, 1).trim()
    ccliTitle = ccliTitle || firstStr(m, 3).trim()
    const nums = ints(m, 6)
    if (nums.length && ccliNumber === null) ccliNumber = nums[0]
  }

  const title = ccliTitle || name || fallbackTitle

  // Cues by uuid, in deck order (field 13)
  const cues = new Map<string, string>()
  const cueOrder: string[] = []
  for (const blob of sub(top, 13)) {
    const m = parseMessage(blob)
    if (m === null) continue
    const uidMsgs = sub(m, 1)
    if (!uidMsgs.length) continue
    const uidMsg = parseMessage(uidMsgs[0])
    const uid = uidMsg ? firstStr(uidMsg, 1) : ""
    if (!uid) continue
    cues.set(uid, cueText(blob))
    cueOrder.push(uid)
  }

  // Groups (field 12): (name, [cue uuids])
  const groups: { name: string; cueIds: string[] }[] = []
  for (const blob of sub(top, 12)) {
    const m = parseMessage(blob)
    if (m === null) continue
    let gname = ""
    for (const gdef of sub(m, 1)) {
      const gm = parseMessage(gdef)
      if (gm) {
        gname = firstStr(gm, 2).trim()
        break
      }
    }
    const cueIds: string[] = []
    for (const ref of sub(m, 2)) {
      const rm = parseMessage(ref)
      if (rm) {
        const rid = firstStr(rm, 1)
        if (rid) cueIds.push(rid)
      }
    }
    groups.push({ name: gname, cueIds })
  }

  // Build sections: one section per slide, preserving the operator's slide
  // breaks. Labeled groups keep their names ("Verse 1 (2/3)" when the group
  // spans multiple slides); unlabeled content becomes Slide n.
  const sections: ConvertedSection[] = []
  let slideNo = 0

  const addSection = (label: string | null, text: string) => {
    const lines = text.split("\n").filter((ln) => ln.trim())
    if (!lines.length) return
    slideNo += 1
    sections.push({ id: crypto.randomUUID(), label: label || `Slide ${slideNo}`, lines })
  }

  const groupedIds = new Set(groups.flatMap((g) => g.cueIds))
  if (groups.length) {
    for (const { name: gname, cueIds } of groups) {
      const generic = GENERIC_GROUP_NAMES.has(gname.toLowerCase())
      const texts = cueIds
        .map((cid) => [cid, cues.get(cid) ?? ""] as const)
        .filter(([, t]) => t.trim())
      texts.forEach(([, t], idx) => {
        let label: string | null
        if (generic) {
          label = null
        } else if (texts.length > 1) {
          label = `${gname} (${idx + 1}/${texts.length})`
        } else {
          label = gname
        }
        addSection(label, t)
      })
    }
    // cues not referenced by any group still belong to the deck
    for (const cid of cueOrder) {
      if (!groupedIds.has(cid)) addSection(null, cues.get(cid) ?? "")
    }
  } else {
    for (const cid of cueOrder) {
      addSection(null, cues.get(cid) ?? "")
    }
  }

  if (!sections.length) return { song: null, reason: "no lyric text (media/countdown deck?)" }

  // Countdown/timer decks survive the empty-text check with digits only
  // ("754:56") — a song must contain at least a few letters.
  const allText = sections
    .flatMap((sec) => sec.lines)
    .join(" ")
  const letterCount = (allText.match(/\p{L}/gu) ?? []).length
  if (letterCount < 4) {
    return { song: null, reason: `no lyric text (timer/number deck: ${JSON.stringify(allText.slice(0, 30))})` }
  }

  const now = Date.now()
  const song: Song = {
    id: crypto.randomUUID(),
    title,
    artist,
    sections,
    arrangement: [],
    createdAt: now,
    updatedAt: now,
  }
  if (ccliNumber) song.ccliNumber = String(ccliNumber)
  return { song, reason: null }
}

// --- bundle handling ----------------------------------------------------------

function normalizeLyrics(song: Song): string {
  const body = song.sections.map((s) => s.lines.join("\n")).join("\n")
  return `${song.title.toLowerCase()} ${body.replace(/\s+/g, " ").toLowerCase().trim()}`
}

export interface ParseProBundleResult {
  songs: Song[]
  skipped: { name: string; reason: string }[]
  duplicates: string[]
}

/**
 * Parses a `.proBundle` (zip of `.pro` presentations) into catalog Songs.
 * Pure and synchronous so it can be unit-tested without Tauri.
 */
export function parseProBundle(bytes: Uint8Array): ParseProBundleResult {
  const zip = unzipSync(bytes)

  const songs: Song[] = []
  const skipped: { name: string; reason: string }[] = []
  const duplicates: string[] = []
  const seen = new Map<string, string>()

  // fflate preserves the zip's central-directory (i.e. write) order in key
  // order, matching the Python converter's zipfile.infolist() iteration.
  const names = Object.keys(zip)
  for (const name of names) {
    if (name.includes("/") || !name.endsWith(".pro")) continue
    const data = zip[name]
    const fallbackTitle = name.slice(0, -".pro".length) || "(untitled)"

    const { song, reason } = convertPro(data, fallbackTitle)
    if (song === null) {
      skipped.push({ name: fallbackTitle, reason: reason ?? "unknown" })
      continue
    }
    const key = normalizeLyrics(song)
    const existingTitle = seen.get(key)
    if (existingTitle !== undefined) {
      duplicates.push(fallbackTitle)
      continue
    }
    seen.set(key, song.title)
    songs.push(song)
  }

  return { songs, skipped, duplicates }
}

/**
 * Opens a native file dialog, reads the selected `.proBundle`, and parses
 * it into catalog Songs. Returns null if the user cancels the dialog.
 */
export async function importProBundleFile(): Promise<ParseProBundleResult | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "ProPresenter bundle", extensions: ["proBundle", "probundle"] }],
  })
  if (!selected) return null

  const path = typeof selected === "string" ? selected : selected
  const bytes = await readFile(path)
  return parseProBundle(bytes)
}
