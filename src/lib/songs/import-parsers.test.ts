// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { parseOpenLyrics, parseOpenSong, parsePlainText } from "./import-parsers"
import openLyricsFixture from "./fixtures/amazing-grace.openlyrics.xml?raw"
import openSongFixture from "./fixtures/amazing-grace.opensong.xml?raw"

describe("parsePlainText", () => {
  it("splits paragraphs on blank lines into unlabeled Verse N sections", () => {
    const result = parsePlainText("line one\nline two\n\nline three\nline four")

    expect(result.sections).toEqual([
      { label: "Verse 1", lines: ["line one", "line two"] },
      { label: "Verse 2", lines: ["line three", "line four"] },
    ])
  })

  it("recognises a leading label line (verse/chorus/bridge/...)", () => {
    const result = parsePlainText("Verse 1\nfirst line\n\nChorus\nsing along\nonce more")

    expect(result.sections).toEqual([
      { label: "Verse 1", lines: ["first line"] },
      { label: "Chorus", lines: ["sing along", "once more"] },
    ])
  })

  it("recognises bracket-wrapped labels", () => {
    const result = parsePlainText("[Bridge]\nquiet part\n\n[Pre-Chorus]\nbuild up")

    expect(result.sections.map((s) => s.label)).toEqual(["Bridge", "Pre-Chorus"])
  })

  it("is case-insensitive and tolerates a numbered label", () => {
    const result = parsePlainText("verse 2\nsecond verse text")
    expect(result.sections[0].label).toBe("Verse 2")
  })

  it("keeps counting unlabeled verses independently of labeled sections", () => {
    const result = parsePlainText("intro line\n\nChorus\nhook\n\nsecond unlabeled")

    expect(result.sections.map((s) => s.label)).toEqual(["Verse 1", "Chorus", "Verse 2"])
  })

  it("throws on empty input", () => {
    expect(() => parsePlainText("")).toThrow(/no lyrics/i)
    expect(() => parsePlainText("   \n\n  ")).toThrow(/no lyrics/i)
  })

  it("returns empty title/artist since plain text carries neither", () => {
    const result = parsePlainText("just a line")
    expect(result.title).toBe("")
    expect(result.artist).toBe("")
  })
})

describe("parseOpenLyrics", () => {
  it("parses title, author, and verse sections from the fixture", () => {
    const result = parseOpenLyrics(openLyricsFixture)

    expect(result.title.length).toBeGreaterThan(0)
    expect(result.sections.length).toBeGreaterThan(0)
    for (const section of result.sections) {
      expect(section.label.length).toBeGreaterThan(0)
      expect(Array.isArray(section.lines)).toBe(true)
    }
  })

  it("maps verse name shorthand to display labels", () => {
    const xml = `<song>
      <properties>
        <titles><title>Test Song</title></titles>
        <authors><author>Jane Doe</author></authors>
      </properties>
      <lyrics>
        <verse name="v1"><lines>First line<br/>Second line</lines></verse>
        <verse name="c1"><lines>Chorus line</lines></verse>
        <verse name="b1"><lines>Bridge line</lines></verse>
        <verse name="p"><lines>Pre-chorus line</lines></verse>
      </lyrics>
    </song>`

    const result = parseOpenLyrics(xml)

    expect(result.title).toBe("Test Song")
    expect(result.artist).toBe("Jane Doe")
    expect(result.sections).toEqual([
      { label: "Verse 1", lines: ["First line", "Second line"] },
      { label: "Chorus", lines: ["Chorus line"] },
      { label: "Bridge", lines: ["Bridge line"] },
      { label: "Pre-Chorus", lines: ["Pre-chorus line"] },
    ])
  })

  it("splits lines on <br/> and drops empty lines", () => {
    const xml = `<song><lyrics><verse name="v2"><lines>a<br/><br/>b<br/>  </lines></verse></lyrics></song>`
    const result = parseOpenLyrics(xml)
    expect(result.sections[0]).toEqual({ label: "Verse 2", lines: ["a", "b"] })
  })

  it("numbers repeated non-verse sections above 1", () => {
    const xml = `<song><lyrics>
      <verse name="c1"><lines>first chorus</lines></verse>
      <verse name="c2"><lines>second chorus</lines></verse>
    </lyrics></song>`
    const result = parseOpenLyrics(xml)
    expect(result.sections.map((s) => s.label)).toEqual(["Chorus", "Chorus 2"])
  })

  it("throws on malformed XML", () => {
    expect(() => parseOpenLyrics("<song><lyrics><verse></song>")).toThrow(/invalid openlyrics/i)
  })

  it("throws when there are no verse elements", () => {
    expect(() => parseOpenLyrics("<song><lyrics></lyrics></song>")).toThrow(/no <verse>/i)
  })
})

describe("parseOpenSong", () => {
  it("parses title, author, and marker sections from the fixture", () => {
    const result = parseOpenSong(openSongFixture)

    expect(result.title.length).toBeGreaterThan(0)
    expect(result.sections.length).toBeGreaterThan(0)
    for (const section of result.sections) {
      expect(section.lines.every((line) => !line.trim().startsWith("."))).toBe(true)
    }
  })

  it("splits on [V1]/[C]-style markers and ignores chord lines", () => {
    const xml = `<song>
      <title>Test Song</title>
      <author>Jane Doe</author>
      <lyrics>[V1]
.G           D
Amazing grace how sweet
The sound

[C]
.Em         D
That saved a wretch
</lyrics>
    </song>`

    const result = parseOpenSong(xml)

    expect(result.title).toBe("Test Song")
    expect(result.artist).toBe("Jane Doe")
    expect(result.sections).toEqual([
      { label: "Verse 1", lines: ["Amazing grace how sweet", "The sound"] },
      { label: "Chorus", lines: ["That saved a wretch"] },
    ])
  })

  it("collects lyric lines that precede any marker into an implicit Verse 1", () => {
    const xml = `<song><title>T</title><author>A</author><lyrics>no marker here
still no marker

[C]
chorus line
</lyrics></song>`

    const result = parseOpenSong(xml)
    expect(result.sections[0]).toEqual({ label: "Verse 1", lines: ["no marker here", "still no marker"] })
    expect(result.sections[1]).toEqual({ label: "Chorus", lines: ["chorus line"] })
  })

  it("throws when the lyrics element is missing", () => {
    expect(() => parseOpenSong("<song><title>T</title></song>")).toThrow(/missing <lyrics>/i)
  })

  it("throws when lyrics contain no usable content", () => {
    expect(() => parseOpenSong("<song><lyrics>\n.G D\n</lyrics></song>")).toThrow(/no lyric content/i)
  })

  it("throws on malformed XML", () => {
    expect(() => parseOpenSong("<song><lyrics>")).toThrow(/invalid opensong/i)
  })
})
