#!/usr/bin/env python3
"""Convert a ProPresenter 7 .proBundle (or a folder of .pro files) into a
Rhema song-catalog JSON (format "rhema-song-catalog", version 1) that the
Songs tab's Import button accepts.

Fork-owned tool (see todo.md). Stdlib only — no pip installs needed.

Usage:
  python3 data/convert-probundle.py <bundle.proBundle | folder> [-o out.json]

ProPresenter 7 .pro files are Protocol Buffers. We walk the wire format
without the schema (field numbers reverse-engineered from real exports):
  field 3  = presentation name
  field 12 = cue groups: {1: {1:{1:uuid}, 2:name}, 2: repeated {1: cue-uuid}}
  field 13 = cues (deck order): {1:{1:uuid}, ...nested slide text elements
             whose RTF blobs we collect recursively}
  field 14 = CCLI metadata: {1:author, 3:title, 4:publisher, 5:year, 6:ccli#}
Slide text lives in RTF blobs; a small RTF-to-text decoder handles the
subset ProPresenter emits (cp1252 escapes, \\uN unicode, \\par/\\line).
"""

import argparse
import json
import re
import sys
import time
import unicodedata
import uuid
import zipfile
from pathlib import Path

# --- protobuf wire-format walker (schema-free) -----------------------------


def read_varint(b, i):
    r = 0
    s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        if not x & 0x80:
            return r, i
        s += 7


def parse_message(b):
    """Parse bytes as a protobuf message; returns [(field, wire, value)] or
    None if the bytes are not a plausible message."""
    out = []
    i = 0
    try:
        while i < len(b):
            tag, i = read_varint(b, i)
            f, w = tag >> 3, tag & 7
            if f == 0 or f > 10000:
                return None
            if w == 0:
                v, i = read_varint(b, i)
            elif w == 1:
                if i + 8 > len(b):
                    return None
                v = b[i : i + 8]
                i += 8
            elif w == 5:
                if i + 4 > len(b):
                    return None
                v = b[i : i + 4]
                i += 4
            elif w == 2:
                ln, i = read_varint(b, i)
                if i + ln > len(b):
                    return None
                v = b[i : i + ln]
                i += ln
            else:
                return None
            out.append((f, w, v))
    except (IndexError, OverflowError):
        return None
    return out


def sub(msg, num):
    """All length-delimited values for a field number."""
    return [v for f, w, v in msg if f == num and w == 2]


def ints(msg, num):
    return [v for f, w, v in msg if f == num and w == 0]


def first_str(msg, num):
    for v in sub(msg, num):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            pass
    return ""


def collect_rtf(b, out, depth=0):
    """Recursively find RTF blobs anywhere inside a message."""
    if depth > 14:
        return
    msg = parse_message(b)
    if msg is None:
        return
    for _f, w, v in msg:
        if w != 2:
            continue
        if v.startswith(b"{\\rtf"):
            out.append(v)
        else:
            collect_rtf(v, out, depth + 1)


# --- RTF -> plain text ------------------------------------------------------

DEST_SKIP = {
    "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
    "expandedcolortbl", "themedata", "info", "pict",
}


def rtf_to_text(data):
    s = data.decode("latin-1")
    out = []
    i, n = 0, len(s)
    skip_depth = 0
    uc = 1
    while i < n:
        c = s[i]
        if c == "{":
            i += 1
            if skip_depth:
                skip_depth += 1
        elif c == "}":
            i += 1
            if skip_depth:
                skip_depth -= 1
        elif c == "\\":
            i += 1
            if i >= n:
                break
            c2 = s[i]
            if c2 == "'":
                h = s[i + 1 : i + 3]
                i += 3
                if not skip_depth:
                    try:
                        out.append(bytes([int(h, 16)]).decode("cp1252"))
                    except (ValueError, UnicodeDecodeError):
                        pass
            elif c2 in "\\{}":
                if not skip_depth:
                    out.append(c2)
                i += 1
            elif c2 in "\r\n":
                if not skip_depth:
                    out.append("\n")
                i += 1
            elif c2 == "*":
                skip_depth = max(skip_depth, 1)
                i += 1
            elif c2.isalpha():
                j = i
                while j < n and s[j].isalpha():
                    j += 1
                word = s[i:j]
                k = j
                if k < n and (s[k] == "-" or s[k].isdigit()):
                    k += 1
                    while k < n and s[k].isdigit():
                        k += 1
                param = s[j:k]
                if k < n and s[k] == " ":
                    k += 1
                i = k
                if word in DEST_SKIP:
                    skip_depth = max(skip_depth, 1)
                elif skip_depth:
                    pass
                elif word in ("par", "line"):
                    out.append("\n")
                elif word == "tab":
                    out.append("\t")
                elif word == "uc":
                    uc = int(param or 1)
                elif word == "u":
                    cp = int(param)
                    if cp < 0:
                        cp += 65536
                    out.append(chr(cp))
                    skipn = uc
                    while skipn and i < n:
                        if s[i] == "\\" and i + 1 < n and s[i + 1] == "'":
                            i += 4
                        else:
                            i += 1
                        skipn -= 1
            else:
                i += 1
        else:
            if not skip_depth and c not in "\r\n\0":
                out.append(c)
            i += 1
    text = "".join(out)
    lines = [ln.strip() for ln in text.split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


# --- .pro -> Song -----------------------------------------------------------

GENERIC_GROUP_NAMES = {"", "group", "slide", "slides"}


def cue_text(cue_bytes):
    """All visible text on one cue's slide (multiple text boxes joined)."""
    blobs = []
    collect_rtf(cue_bytes, blobs)
    parts = []
    for b in blobs:
        t = rtf_to_text(b)
        if t and t not in parts:
            parts.append(t)
    return "\n".join(parts)


def convert_pro(data, fallback_title):
    top = parse_message(data)
    if top is None:
        return None, "not a protobuf presentation"

    name = first_str(top, 3).strip()

    # CCLI metadata (field 14)
    artist = ""
    ccli_title = ""
    ccli_number = None
    for blob in sub(top, 14):
        m = parse_message(blob)
        if m is None:
            continue
        artist = artist or first_str(m, 1).strip()
        ccli_title = ccli_title or first_str(m, 3).strip()
        nums = ints(m, 6)
        if nums and ccli_number is None:
            ccli_number = nums[0]

    title = ccli_title or name or fallback_title

    # Cues by uuid, in deck order (field 13)
    cues = {}
    cue_order = []
    for blob in sub(top, 13):
        m = parse_message(blob)
        if m is None:
            continue
        uid_msgs = sub(m, 1)
        if not uid_msgs:
            continue
        uid_msg = parse_message(uid_msgs[0])
        uid = first_str(uid_msg, 1) if uid_msg else ""
        if not uid:
            continue
        cues[uid] = cue_text(blob)
        cue_order.append(uid)

    # Groups (field 12): (name, [cue uuids])
    groups = []
    for blob in sub(top, 12):
        m = parse_message(blob)
        if m is None:
            continue
        gname = ""
        for gdef in sub(m, 1):
            gm = parse_message(gdef)
            if gm:
                gname = first_str(gm, 2).strip()
                break
        cue_ids = []
        for ref in sub(m, 2):
            rm = parse_message(ref)
            if rm:
                rid = first_str(rm, 1)
                if rid:
                    cue_ids.append(rid)
        groups.append((gname, cue_ids))

    # Build sections: one section per slide, preserving the operator's
    # slide breaks. Labeled groups keep their names ("Verse 1 (2/3)" when
    # the group spans multiple slides); unlabeled content becomes Slide n.
    sections = []
    slide_no = 0

    def add_section(label, text):
        nonlocal slide_no
        lines = [ln for ln in text.split("\n") if ln.strip()]
        if not lines:
            return
        slide_no += 1
        sections.append(
            {"id": str(uuid.uuid4()), "label": label or f"Slide {slide_no}", "lines": lines}
        )

    grouped_ids = {cid for _n, cids in groups for cid in cids}
    if groups:
        for gname, cue_ids in groups:
            generic = gname.lower() in GENERIC_GROUP_NAMES
            texts = [(cid, cues.get(cid, "")) for cid in cue_ids]
            texts = [(cid, t) for cid, t in texts if t.strip()]
            for idx, (_cid, t) in enumerate(texts, 1):
                if generic:
                    label = None
                elif len(texts) > 1:
                    label = f"{gname} ({idx}/{len(texts)})"
                else:
                    label = gname
                add_section(label, t)
        # cues not referenced by any group still belong to the deck
        for cid in cue_order:
            if cid not in grouped_ids:
                add_section(None, cues.get(cid, ""))
    else:
        for cid in cue_order:
            add_section(None, cues.get(cid, ""))

    if not sections:
        return None, "no lyric text (media/countdown deck?)"

    # Countdown/timer decks survive the empty-text check with digits only
    # ("754:56") — a song must contain at least a few letters.
    all_text = " ".join(ln for sec in sections for ln in sec["lines"])
    if sum(c.isalpha() for c in all_text) < 4:
        return None, f"no lyric text (timer/number deck: {all_text[:30]!r})"

    now_ms = int(time.time() * 1000)
    song = {
        "id": str(uuid.uuid4()),
        "title": title,
        "artist": artist,
        "sections": sections,
        "arrangement": [],
        "createdAt": now_ms,
        "updatedAt": now_ms,
    }
    if ccli_number:
        song["ccliNumber"] = str(ccli_number)
    return song, None


# --- bundle handling --------------------------------------------------------


def iter_pro_files(src):
    """Yield (name, bytes) for every .pro presentation in a bundle or dir."""
    p = Path(src)
    if p.is_dir():
        for f in sorted(p.iterdir()):
            if f.suffix == ".pro":
                yield f.stem, f.read_bytes()
        return
    with zipfile.ZipFile(p) as zf:
        for info in zf.infolist():
            name = info.filename
            if not (info.flag_bits & 0x800):
                try:
                    name = name.encode("cp437").decode("utf-8")
                except (UnicodeDecodeError, UnicodeEncodeError):
                    pass
            name = unicodedata.normalize("NFC", name)
            if info.is_dir() or "/" in name or not name.endswith(".pro"):
                continue
            yield name[: -len(".pro")] or "(untitled)", zf.read(info)


def normalize_lyrics(song):
    body = "\n".join("\n".join(s["lines"]) for s in song["sections"])
    return song["title"].casefold(), re.sub(r"\s+", " ", body).casefold().strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", help=".proBundle file or folder of .pro files")
    ap.add_argument("-o", "--out", default="song-catalog.json")
    ap.add_argument(
        "--keep-duplicates",
        action="store_true",
        help="keep songs whose title+lyrics exactly match an earlier song",
    )
    args = ap.parse_args()

    songs = []
    skipped = []
    dupes = []
    seen = {}
    for name, data in iter_pro_files(args.source):
        song, why = convert_pro(data, fallback_title=name)
        if song is None:
            skipped.append((name, why))
            continue
        key = normalize_lyrics(song)
        if key in seen and not args.keep_duplicates:
            dupes.append((name, seen[key]))
            continue
        seen.setdefault(key, song["title"])
        songs.append(song)

    payload = {
        "format": "rhema-song-catalog",
        "version": 1,
        "exportedAt": int(time.time() * 1000),
        "songs": songs,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2))

    print(f"Converted {len(songs)} songs -> {args.out}")
    if dupes:
        print(f"\nSkipped {len(dupes)} exact duplicates (same title + lyrics):")
        for name, kept in dupes:
            print(f"  - {name!r} (duplicate of {kept!r})")
    if skipped:
        print(f"\nSkipped {len(skipped)} non-song presentations:")
        for name, why in skipped:
            print(f"  - {name!r}: {why}")


if __name__ == "__main__":
    sys.exit(main())
