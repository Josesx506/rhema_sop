import { describe, expect, it } from "vitest"
import { zipSync } from "fflate"
import { parseProBundle } from "./probundle-import"

// ── Minimal protobuf encoder, just enough to synthesize fake ProPresenter 7
//    `.pro` presentations for these tests (no real ProPresenter files are
//    used or shipped — those are copyrighted). Mirrors the field layout
//    documented at the top of probundle-import.ts / data/convert-probundle.py. ──

function encodeVarint(value: number): number[] {
  const bytes: number[] = []
  let v = value
  do {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    bytes.push(b)
  } while (v > 0)
  return bytes
}

function tagBytes(field: number, wireType: number): number[] {
  return encodeVarint((field << 3) | wireType)
}

function concatBytes(parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = []
  for (const part of parts) flat.push(...Array.from(part))
  return new Uint8Array(flat)
}

/** A length-delimited field (wire type 2): tag + varint length + payload. */
function lenDelimField(field: number, payload: Uint8Array): Uint8Array {
  return concatBytes([tagBytes(field, 2), encodeVarint(payload.length), payload])
}

function strField(field: number, value: string): Uint8Array {
  return lenDelimField(field, new TextEncoder().encode(value))
}

function varintField(field: number, value: number): Uint8Array {
  return concatBytes([tagBytes(field, 0), encodeVarint(value)])
}

/** The `{1: uuid}` submessage shape used for both cue and group-cue ids. */
function uuidMsg(id: string): Uint8Array {
  return strField(1, id)
}

/** Buries an RTF blob two nested messages deep, to exercise the recursive
 * RTF collector (not just a directly-attached field). */
function nestedTextBox(rtf: string): Uint8Array {
  const rtfBytes = new TextEncoder().encode(rtf)
  const inner = lenDelimField(1, rtfBytes)
  return lenDelimField(2, inner)
}

function cuePresentationBytes(uuid: string, rtf: string): Uint8Array {
  return concatBytes([lenDelimField(1, uuidMsg(uuid)), lenDelimField(7, nestedTextBox(rtf))])
}

function groupNameDef(uuid: string, name: string): Uint8Array {
  return concatBytes([lenDelimField(1, uuidMsg(uuid)), strField(2, name)])
}

function groupBytes(uuid: string, name: string, cueIds: string[]): Uint8Array {
  return concatBytes([
    lenDelimField(1, groupNameDef(uuid, name)),
    ...cueIds.map((cid) => lenDelimField(2, strField(1, cid))),
  ])
}

// ── Fixture presentations ──

const VERSE_RTF_1 = "{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\pard Amazing grace how sweet the sound\\par}"
const VERSE_RTF_2 = "{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\pard That saved a wretch like me\\par}"

function buildAmazingGracePresentation(): Uint8Array {
  const cue1 = cuePresentationBytes("cue-1", VERSE_RTF_1)
  const cue2 = cuePresentationBytes("cue-2", VERSE_RTF_2)
  const group = groupBytes("group-1", "Verse 1", ["cue-1", "cue-2"])
  const ccli = concatBytes([
    strField(1, "John Newton"),
    strField(3, "Amazing Grace"),
    varintField(5, 1779),
    varintField(6, 1234567),
  ])
  return concatBytes([
    strField(3, "AmazingGraceDeck"),
    lenDelimField(12, group),
    lenDelimField(13, cue1),
    lenDelimField(13, cue2),
    lenDelimField(14, ccli),
  ])
}

function buildTimerPresentation(): Uint8Array {
  const cue = cuePresentationBytes("cue-timer", "{\\rtf1\\ansi\\pard 754:56}")
  return concatBytes([strField(3, "CountdownDeck"), lenDelimField(13, cue)])
}

describe("parseProBundle", () => {
  it("converts a presentation with a labeled group into song sections, using CCLI metadata for title/artist", () => {
    const presentation = buildAmazingGracePresentation()
    const bundle = zipSync({ "Amazing Grace.pro": presentation })

    const result = parseProBundle(bundle)

    expect(result.songs).toHaveLength(1)
    const song = result.songs[0]
    expect(song.title).toBe("Amazing Grace")
    expect(song.artist).toBe("John Newton")
    expect(song.ccliNumber).toBe("1234567")
    expect(song.arrangement).toEqual([])
    expect(typeof song.id).toBe("string")
    expect(song.id.length).toBeGreaterThan(0)
    expect(typeof song.createdAt).toBe("number")
    expect(typeof song.updatedAt).toBe("number")

    expect(song.sections).toHaveLength(2)
    expect(song.sections[0].label).toBe("Verse 1 (1/2)")
    expect(song.sections[0].lines).toEqual(["Amazing grace how sweet the sound"])
    expect(song.sections[1].label).toBe("Verse 1 (2/2)")
    expect(song.sections[1].lines).toEqual(["That saved a wretch like me"])

    expect(result.skipped).toEqual([])
    expect(result.duplicates).toEqual([])
  })

  it("skips timer/countdown decks whose text has fewer than 4 letters", () => {
    const bundle = zipSync({ "Countdown Timer.pro": buildTimerPresentation() })

    const result = parseProBundle(bundle)

    expect(result.songs).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].name).toBe("Countdown Timer")
    expect(result.skipped[0].reason).toMatch(/timer|number/i)
  })

  it("dedupes an exact title+lyrics duplicate, keeping the first occurrence", () => {
    const presentation = buildAmazingGracePresentation()
    const bundle = zipSync({
      "Amazing Grace.pro": presentation,
      "Amazing Grace copy.pro": presentation,
      "Countdown Timer.pro": buildTimerPresentation(),
    })

    const result = parseProBundle(bundle)

    expect(result.songs).toHaveLength(1)
    expect(result.songs[0].title).toBe("Amazing Grace")
    expect(result.duplicates).toEqual(["Amazing Grace copy"])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].name).toBe("Countdown Timer")
  })

  it("skips zip entries in subdirectories and non-.pro files", () => {
    const bundle = zipSync({
      "readme.txt": new TextEncoder().encode("not a presentation"),
      "Subfolder/Nested.pro": buildAmazingGracePresentation(),
    })

    const result = parseProBundle(bundle)

    expect(result.songs).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.duplicates).toEqual([])
  })
})
