#!/usr/bin/env python3
"""Bounded, explicit conversions into Lamplighter's existing JSON format.

Only the standard library is needed. Legacy DOC and installed SWORD modules use
antiword and mod2osis, respectively; neither tool is downloaded or run by a shell.
"""
import argparse
import configparser
import copy
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 64 * 1024 * 1024
MAX_NUMBER = 1000
MAX_SLOTS = 2_000_000
BOOKS = json.loads((ROOT / "lib/book-ids.json").read_text())


class ConversionError(ValueError):
    pass


def norm(value):
    return re.sub(r"[\s._-]+", "", str(value)).casefold()


ALIASES = {norm(b[k]): b for b in BOOKS for k in ("name", "abbrev", "osis", "usfm")}
for alias, name in {"Psalm": "Psalms", "Song of Songs": "Song of Solomon", "Canticles": "Song of Solomon", "Ecclesiasticus": "Sirach", "Wisdom": "Wisdom of Solomon", "AddPs": "Psalm 151", "Ps151": "Psalm 151"}.items():
    ALIASES[norm(alias)] = ALIASES[norm(name)]


def book_id(value):
    try:
        return ALIASES[norm(value)]
    except KeyError:
        raise ConversionError(f"Unknown book {value!r}; use a supported English name, OSIS ID, or USFM code.") from None


def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not re.fullmatch(r"[1-9][0-9]*", str(value)):
        raise ConversionError(f"{label}: expected a positive whole number; verse suffixes/ranges need explicit handling.")
    result = int(value)
    if result > MAX_NUMBER:
        raise ConversionError(f"{label}: exceeds the supported bound of {MAX_NUMBER}.")
    return result


def read_bytes(path):
    with Path(path).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ConversionError("Input exceeds the 64 MiB limit; split the resource into smaller inputs.")
    return data


def decode(data):
    try:
        return data.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        raise ConversionError("Input must be UTF-8; convert its encoding explicitly first.") from None


def source_lines(text):
    if not text:
        return []
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    return lines[:-1] if text.endswith("\n") else lines


def load_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ConversionError("JSON contains a duplicate property; resolve it before conversion.")
            result[key] = value
        return result

    def constant(_):
        raise ConversionError("JSON cannot contain NaN or Infinity.")

    return json.loads(decode(data), object_pairs_hook=pairs, parse_constant=constant)


def write_atomic(path, data, force=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if force:
            os.replace(temporary, path)
        else:
            # Link into place only if the destination is still absent. This also
            # closes the race between preflight and writing an existing file.
            os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def xml_root(data):
    # Reject DTDs before parsing, including UTF-16/32 spellings. External entities
    # and entity expansion are never required by the supported import formats.
    if b"<!DOCTYPE" in data.upper().replace(b"\x00", b"") or b"<!ENTITY" in data.upper().replace(b"\x00", b""):
        raise ConversionError("XML DTDs and entity declarations are not allowed.")
    if len(data) > MAX_BYTES:
        raise ConversionError("XML exceeds the 64 MiB limit.")
    try:
        depth = count = 0
        parser = ET.iterparse(io.BytesIO(data), events=("start", "end"))
        for event, _ in parser:
            if event == "start":
                depth += 1
                count += 1
                if depth > 128 or count > 2_000_000:
                    raise ConversionError("XML nesting or element count exceeds the import limit.")
            else:
                depth -= 1
        return parser.root
    except ET.ParseError as error:
        raise ConversionError(f"Malformed XML: {error}") from None


def tag(element):
    return element.tag.rsplit("}", 1)[-1]


class Report:
    def __init__(self, allow_lossy=False):
        self.allow_lossy = allow_lossy
        self.events = {}

    def event(self, code, message, count=1):
        item = self.events.setdefault(code, {"code": code, "count": 0, "message": message})
        item["count"] += count

    def loss(self, code, message):
        if not self.allow_lossy:
            raise ConversionError(f"{message} Use --allow-lossy to accept this conversion and inspect its report.")
        self.event(code, message)


class Edition:
    def __init__(self, report):
        self.report = report
        self.books = {}
        self.slots = 0

    def add(self, book, chapter, verse, text):
        b = book_id(book)
        c = number(chapter, "Chapter")
        raw = str(verse)
        if re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", raw):
            first, last = (number(x, "Verse bridge") for x in raw.split("-"))
            if last <= first:
                raise ConversionError("Verse bridge end must follow its start.")
            self.report.loss("verse-bridge", "Combined verse text is stored at the first verse; remaining bridge positions are empty, not reconstructed.")
        else:
            first = last = number(verse, "Verse")
        key = b["osis"]
        if key not in self.books:
            if len(self.books) >= 512:
                raise ConversionError("Too many books.")
            self.books[key] = {"identity": b, "chapters": {}}
        chapter_map = self.books[key]["chapters"].setdefault(c, {})
        for v in range(first, last + 1):
            if v in chapter_map:
                raise ConversionError(f"Duplicate verse: {b['name']} {c}:{v}.")
            chapter_map[v] = {"verse": v, "text": text if v == first else ""}
        if first != last:
            chapter_map[first]["sourceVerse"] = raw

    def finish(self):
        if not self.books:
            raise ConversionError("No verses were found.")
        books = []
        for record in self.books.values():
            b = record["identity"]
            cmap = record["chapters"]
            chapters = []
            for c in range(1, max(cmap) + 1):
                vmap = cmap.get(c, {})
                maximum = max(vmap, default=0)
                self.slots += maximum
                if self.slots > MAX_SLOTS:
                    raise ConversionError("Expanded verse slots exceed the import limit.")
                missing = maximum - len(vmap)
                if missing:
                    self.report.event("missing-verse-slots", "Absent numbered verses were represented by empty text; no wording was invented.", missing)
                if c not in cmap:
                    self.report.event("missing-chapters", "Absent numbered chapters were represented by empty verse arrays.")
                chapters.append({"chapter": c, "verses": [vmap.get(v, {"verse": v, "text": ""}) for v in range(1, maximum + 1)]})
            books.append({"name": b["name"], "abbrev": b["abbrev"], "osis": b["osis"], "chapters": chapters})
        return {"books": books}


def parse_reference(value):
    match = re.fullmatch(r"(.+?)\s+([1-9][0-9]*)(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?", value.strip())
    if not match:
        return book_id(value), None, None, None
    b, c, v, end = match.groups()
    return book_id(b), number(c, "Chapter"), number(v, "Verse") if v else None, number(end, "End verse") if end else None


def referenced_lines(text, report, kind="edition", reference=None):
    edition = Edition(report)
    entries = []
    if reference is not None and (not isinstance(reference, dict) or not isinstance(reference.get("books"), list) or any(not isinstance(b, dict) for b in reference["books"])):
        raise ConversionError("Reference edition must contain a books array of book objects.")
    reference_books = [b.get("name", b.get("book", "")) for b in reference.get("books", [])] if reference else []
    reference_lookup = {}
    for i, b in enumerate(reference.get("books", []) if reference else []):
        for field in ("name", "book", "osis", "abbrev", "abbr"):
            if b.get(field):
                try:
                    identity = book_id(b[field])["osis"]
                    if identity in reference_lookup and reference_lookup[identity] != i:
                        raise ConversionError("Reference edition contains ambiguous or repeated book identities.")
                    reference_lookup[identity] = i
                except ConversionError:
                    if norm(b[field]) in ALIASES:
                        raise
    if kind == "commentary" and not reference_books:
        raise ConversionError("Commentary conversion needs --reference-edition so book_index matches the Bible's actual book order.")
    for line_number, line in enumerate(source_lines(text), 1):
        if not line.strip():
            continue
        if "\t" in line:
            ref, content = line.split("\t", 1)
        else:
            m = re.fullmatch(r"(.+?\s+[1-9][0-9]*:[1-9][0-9]*(?:-[1-9][0-9]*)?)(?:\s+(.*))?", line)
            if not m:
                raise ConversionError(f"Line {line_number}: expected 'John 1:1 text' or a reference and content separated by a tab.")
            ref, content = m.group(1), m.group(2) or ""
        try:
            b, c, v, end = parse_reference(ref)
            if kind == "edition":
                if c is None or v is None:
                    raise ConversionError("A Bible line needs a chapter and verse.")
                edition.add(b["osis"], c, f"{v}-{end}" if end is not None else v, content)
            else:
                if b["osis"] not in reference_lookup:
                    raise ConversionError(f"{b['name']} is absent from the reference edition.")
                if not content.strip():
                    raise ConversionError("Commentary content cannot be empty.")
                if end is not None and end < v:
                    raise ConversionError("Commentary range is reversed.")
                point = {"book": reference_books[reference_lookup[b["osis"]]], "book_index": reference_lookup[b["osis"]]}
                if c is not None:
                    point["chapter"] = c
                if v is not None:
                    point["verse"] = v
                finish = {**point, **({"verse": end} if end is not None else {})}
                entries.append({"range": {"start": point, "end": finish}, "content": content.replace("\\n", "\n")})
        except ConversionError as error:
            raise ConversionError(f"Line {line_number}: {error}") from None
    if kind == "commentary":
        if not entries:
            raise ConversionError("No commentary entries were found.")
        return {"type": "commentary", "referenceBooks": reference_books, "entries": entries}
    return edition.finish()


def normalize_json(data, report):
    if not isinstance(data, dict) or not isinstance(data.get("books"), list) or not data["books"]:
        raise ConversionError("JSON normalization expects an edition with a non-empty books array.")
    result = copy.deepcopy(data)
    slots = 0
    if len(result["books"]) > 512:
        raise ConversionError("Too many books.")
    for book in result["books"]:
        if not isinstance(book, dict) or not isinstance(book.get("chapters"), list) or not book["chapters"]:
            raise ConversionError("Each book needs a non-empty chapters array.")
        chapters = {}
        for cpos, chapter in enumerate(book["chapters"], 1):
            if not isinstance(chapter, dict) or not isinstance(chapter.get("verses"), list):
                raise ConversionError("Each chapter needs a verses array.")
            if "chapter" in chapter and type(chapter["chapter"]) is not int:
                raise ConversionError("JSON chapter numbers must be integers.")
            c = number(chapter.get("chapter", cpos), "Chapter")
            if c in chapters:
                raise ConversionError(f"Duplicate chapter {c}.")
            verses = {}
            for vpos, verse in enumerate(chapter["verses"], 1):
                if not isinstance(verse, dict) or not isinstance(verse.get("text"), str):
                    raise ConversionError("Each verse needs a text string.")
                if "verse" in verse and type(verse["verse"]) is not int:
                    raise ConversionError("JSON verse numbers must be integers.")
                v = number(verse.get("verse", vpos), "Verse")
                if v in verses:
                    raise ConversionError(f"Duplicate verse {c}:{v}.")
                verses[v] = {**verse, "verse": v}
            maximum = max(verses, default=0)
            slots += maximum
            if slots > MAX_SLOTS:
                raise ConversionError("Expanded verse slots exceed the import limit.")
            if maximum > len(verses):
                report.event("missing-verse-slots", "Absent numbered verses were represented by empty text; original verse objects are preserved.", maximum - len(verses))
            chapters[c] = {**chapter, "chapter": c, "verses": [verses.get(v, {"verse": v, "text": ""}) for v in range(1, maximum + 1)]}
        for c in range(1, max(chapters) + 1):
            if c not in chapters:
                report.event("missing-chapters", "Absent numbered chapters were represented by empty verse arrays.")
        book["chapters"] = [chapters.get(c, {"chapter": c, "verses": []}) for c in range(1, max(chapters) + 1)]
    return result


def unnumbered_lines(text, layout, report):
    result = normalize_json(layout, report)
    # Count explicit CR/LF lines; Unicode paragraph characters inside a verse
    # remain content rather than silently changing the verse count.
    lines = source_lines(text)
    expected = sum(len(c["verses"]) for b in result["books"] for c in b["chapters"])
    if len(lines) != expected:
        raise ConversionError(f"Unnumbered lines need exactly {expected} lines for the supplied layout; found {len(lines)}. Blank lines count as empty verses.")
    position = 0
    for book in result["books"]:
        for chapter in book["chapters"]:
            for verse in chapter["verses"]:
                verse["text"] = lines[position]
                position += 1
    return result


TAG_OPEN, TAG_MID, TAG_CLOSE, ADD_OPEN, ADD_CLOSE = "\ue000", "\ue001", "\ue002", "\ue003", "\ue004"
MARKERS = re.compile("[\ue000-\ue004]")


def strongs_numbers(values):
    """Strong's numbers in a tag ("H0430", "strong:H1254a", "H0853,H0776") as ["H430", ...]."""
    out = []
    for value in values:
        for item in re.split(r"[\s,]+", value):
            match = re.fullmatch(r"(?:strong:)?([GH])0*([0-9]+)[a-z]?", item.strip())
            if match and match.group(1) + match.group(2) not in out:
                out.append(match.group(1) + match.group(2))
    return out


def tag_open(numbers):
    return TAG_OPEN + " ".join(numbers) + TAG_MID


def flatten(text):
    return re.sub(r"\s+", " ", text).strip()


def parse_osis(data, report, tags=False):
    root = xml_root(data)
    if tag(root) != "osis":
        raise ConversionError("Expected an OSIS document with an <osis> root.")
    edition = Edition(report)
    active = None
    pieces = []

    def finish(expected=None):
        nonlocal active, pieces
        if active is None:
            raise ConversionError("OSIS verse end has no matching start.")
        if expected is not None and expected != active[0]:
            raise ConversionError("OSIS verse milestone IDs do not match.")
        _, b, c, v = active
        edition.add(b, c, v, flatten("".join(pieces)))
        active, pieces = None, []

    def walk(element):
        nonlocal active
        name = tag(element)
        if name in {"header", "note", "title", "figure", "reference"}:
            if name != "header" and (name == "figure" or any(t.strip() for t in element.itertext())):
                report.loss("osis-annotations", "OSIS headings, notes, figures, or reference annotations are omitted from plain verse text.")
            return
        if name == "verse":
            if element.get("eID"):
                finish(element.get("eID"))
                return
            if active is not None:
                raise ConversionError("Overlapping or unclosed OSIS verses.")
            ref = element.get("osisID") or element.get("sID") or ""
            match = re.fullmatch(r"([A-Za-z0-9]+)\.([1-9][0-9]*)\.([1-9][0-9]*)", ref)
            if not match:
                raise ConversionError("OSIS verse IDs must identify one whole verse; combined IDs/subverses need manual review.")
            active = (element.get("sID") or ref, *match.groups())
        elif name not in {"osis", "osisText", "div", "chapter", "p", "lg", "l", "w", "hi", "q", "seg", "transChange", "lb", "milestone"}:
            raise ConversionError(f"Unsupported OSIS element: {name}.")
        if name == "q" and (element.get("sID") or element.get("eID")):
            raise ConversionError("OSIS quotation milestones need manual review or an export with literal punctuation.")
        if active is not None and name in {"w", "hi", "q", "seg", "transChange"}:
            if name == "q":
                if "marker" not in element.attrib:
                    report.loss("osis-implicit-punctuation", "OSIS implicit quotation marks are not reconstructed; use an export with literal punctuation.")
                elif element.get("marker"):
                    pieces.append(element.get("marker"))
            report.event("inline-formatting", "Inline formatting/word attributes are flattened; the contained words are retained.")
        if name == "milestone" and element.get("marker"):
            report.loss("osis-milestone-markers", "OSIS typographic milestone markers are omitted from plain verse text.")
        if active is not None and name in {"p", "l", "lb"}:
            pieces.append(" ")
        numbers = strongs_numbers([element.get("lemma", "")]) if tags and active is not None and name == "w" else []
        added = tags and active is not None and name == "transChange" and element.get("type") == "added"
        if numbers:
            pieces.append(tag_open(numbers))
        if added:
            pieces.append(ADD_OPEN)
        if active is not None and element.text:
            pieces.append(element.text)
        elif element.text and element.text.strip():
            report.loss("osis-unreferenced", "OSIS text outside numbered verses is omitted.")
        for child in element:
            walk(child)
            if active is not None and child.tail:
                pieces.append(child.tail)
            elif child.tail and child.tail.strip():
                report.loss("osis-unreferenced", "OSIS text outside numbered verses is omitted.")
        if numbers:
            pieces.append(TAG_CLOSE)
        if added:
            pieces.append(ADD_CLOSE)
        if active is not None and name == "q" and element.get("marker"):
            pieces.append(element.get("marker"))
        if name == "verse" and not element.get("sID"):
            finish()

    walk(root)
    if active is not None:
        raise ConversionError("OSIS contains an unclosed verse milestone.")
    return edition.finish()


PARAGRAPHS = re.compile(r"(?:p|m|po|pr|cls|pmo|pm|pmc|pmr|pi[0-9]*|mi|nb|pc|ph[0-9]*|q[0-9]*|qr|qc|qm[0-9]*|lh|li[0-9]*|lf|lim[0-9]*|b)")
HEADINGS = re.compile(r"(?:h[0-9]*|toc[0-9]*|toca[0-9]*|mt[0-9]*|mte[0-9]*|ms[0-9]*|mr|s[0-9]*|sr|r|d|sp|cl|cd|qa|qd|rem|sts|i(?:mt|mte|s|p|pi|m|mi|li|q|b|ot|o|ex|e)[0-9]*)")
CHARS = {"add", "bk", "dc", "k", "nd", "ord", "pn", "png", "qt", "sig", "sls", "tl", "wj", "em", "bd", "it", "bdit", "no", "sc", "sup", "wa", "wg", "wh", "lik", "liv"}


def parse_usfm(text, report, tags=False):
    tokens = re.split(r"\\(\+?[A-Za-z][A-Za-z0-9-]*\*?|\*)", text)
    if tokens[0].strip():
        raise ConversionError("USFM must begin with a marker, normally \\id.")
    edition = Edition(report)
    book = chapter = verse = None
    pieces = []
    skipping = None
    stack = []
    heading = False  # inside a heading paragraph, such as a psalm title with tagged words

    def flush():
        nonlocal verse, pieces
        if verse is not None:
            edition.add(book, chapter, verse, flatten("".join(pieces)))
        verse, pieces = None, []

    for i in range(1, len(tokens), 2):
        marker, content = tokens[i], tokens[i + 1]
        bare = marker.lstrip("+").rstrip("*")
        closing = marker.endswith("*")
        if skipping:
            if bare == skipping and closing:
                skipping = None
                if verse is not None:
                    pieces.append(content)
            continue
        if bare in {"f", "fe", "x", "fig"} and not closing:
            report.loss("usfm-annotations", "USFM notes, cross-references, and figures are omitted from plain verse text.")
            skipping = bare
            continue
        if marker in {"id", "c", "v"}:
            if stack:
                raise ConversionError("USFM character markup crosses a chapter/verse boundary.")
            heading = False
            flush()
            bits = content.strip().split(maxsplit=1)
            if not bits:
                raise ConversionError(f"USFM \\{marker} needs a value.")
            value, rest = bits[0], bits[1] if len(bits) > 1 else ""
            if marker == "id":
                book, chapter = book_id(value)["osis"], None
            elif marker == "c":
                if book is None:
                    raise ConversionError("USFM chapter occurs before a book ID.")
                chapter = number(value, "USFM chapter")
                if rest.strip():
                    raise ConversionError("USFM chapter marker has unmarked text before a verse.")
            else:
                if book is None or chapter is None:
                    raise ConversionError("USFM verse occurs before its book/chapter.")
                verse, pieces = value, [rest]
        elif marker in {"usfm", "ide"}:
            if marker == "ide" and content.strip().upper() not in {"UTF-8", "65001 - UNICODE (UTF-8)"}:
                raise ConversionError("USFM declares an unsupported encoding; provide UTF-8.")
        elif HEADINGS.fullmatch(marker):
            heading = verse is None
            if content.strip():
                report.loss("usfm-headings", "USFM headings and introductory paragraphs are omitted from plain verse text.")
        elif PARAGRAPHS.fullmatch(marker):
            heading = False
            if verse is not None:
                pieces.extend([" ", content])
            elif content.strip():
                report.loss("usfm-unreferenced", "USFM text outside a numbered verse is omitted.")
        elif (bare in CHARS or bare == "w") and verse is None and heading:
            if closing:
                if not stack or stack.pop() != bare:
                    raise ConversionError("USFM character markers are not balanced.")
            else:
                stack.append(bare)
            if content.strip():
                report.loss("usfm-headings", "USFM headings and introductory paragraphs are omitted from plain verse text.")
        elif bare in CHARS or bare == "w":
            if verse is None:
                raise ConversionError("USFM character markup occurs outside a verse.")
            if closing:
                if not stack or stack.pop() != bare:
                    raise ConversionError("USFM character markers are not balanced.")
                if tags and bare in {"w", "add"}:
                    pieces.append(TAG_CLOSE if bare == "w" else ADD_CLOSE)
                pieces.append(content)
            else:
                stack.append(bare)
                numbers = []
                if bare == "w" and "|" in content:
                    content, attributes = content.split("|", 1)
                    numbers = strongs_numbers(re.findall(r'strong="([^"]*)"', attributes))
                if tags and bare == "w":
                    content = tag_open(numbers) + content
                elif tags and bare == "add":
                    content = ADD_OPEN + content
                pieces.append(content)
                report.event("inline-formatting", "Inline formatting/word attributes are flattened; the contained words are retained.")
        else:
            raise ConversionError(f"Unsupported USFM marker \\{marker}; convert through a full USFM editor/exporter or review this construct.")
    if skipping or stack:
        raise ConversionError("USFM contains an unclosed annotation or character marker.")
    flush()
    return edition.finish()


def parse_usx(data, report):
    root = xml_root(data)
    if tag(root) != "usx":
        raise ConversionError("Expected a <usx> document.")
    edition = Edition(report)
    book = chapter = verse = active_id = chapter_id = None
    pieces = []

    def finish():
        nonlocal verse, pieces, active_id
        if verse is not None:
            edition.add(book, chapter, verse, flatten("".join(pieces)))
        verse, pieces, active_id = None, [], None

    def walk(element):
        nonlocal book, chapter, verse, active_id, chapter_id
        name, style = tag(element), element.get("style", "")
        if name == "book":
            if active_id is not None:
                raise ConversionError("USX changes books before closing a verse.")
            finish()
            book, chapter = book_id(element.get("code", ""))["osis"], None
            return
        if name == "chapter":
            if active_id is not None:
                raise ConversionError("USX chapter boundary has an unclosed verse.")
            finish()
            if element.get("eid"):
                if element.get("eid") != chapter_id:
                    raise ConversionError("USX chapter milestone IDs do not match.")
                chapter_id = None
                return
            if book is None:
                raise ConversionError("USX chapter occurs before a book.")
            chapter = number(element.get("number", ""), "USX chapter")
            chapter_id = element.get("sid")
            return
        if name == "verse":
            if element.get("eid"):
                if active_id is None or element.get("eid") != active_id:
                    raise ConversionError("USX verse milestone IDs do not match.")
                finish()
                return
            if active_id is not None:
                raise ConversionError("USX contains overlapping verse milestones.")
            finish()
            if book is None or chapter is None:
                raise ConversionError("USX verse occurs before its book/chapter.")
            verse = element.get("number", "")
            active_id = element.get("sid")
            if active_id:
                ref_book, ref_chapter, ref_verse, ref_end = parse_reference(active_id)
                ref_number = f"{ref_verse}-{ref_end}" if ref_end else str(ref_verse)
                if ref_book["osis"] != book or ref_chapter != chapter or ref_number != verse:
                    raise ConversionError("USX verse sid disagrees with its book/chapter/number.")
            return
        if name in {"note", "figure"}:
            report.loss("usx-annotations", "USX notes and figures are omitted from plain verse text.")
            return
        if name == "para":
            if HEADINGS.fullmatch(style):
                if any(tag(child) == "verse" for child in element.iter()):
                    raise ConversionError("A USX heading unexpectedly contains verse markers.")
                if any(t.strip() for t in element.itertext()):
                    report.loss("usx-headings", "USX headings and introductory paragraphs are omitted from plain verse text.")
                return
            if not PARAGRAPHS.fullmatch(style):
                raise ConversionError(f"Unsupported USX paragraph style: {style}.")
            if verse is not None:
                pieces.append(" ")
        elif name == "char":
            if style not in CHARS and style != "w":
                raise ConversionError(f"Unsupported USX character style: {style}.")
            report.event("inline-formatting", "Inline formatting/word attributes are flattened; the contained words are retained.")
        elif name == "optbreak":
            if verse is not None:
                pieces.append(" ")
            return
        elif name != "usx":
            raise ConversionError(f"Unsupported USX element: {name}.")
        if element.text and element.text.strip():
            if verse is None:
                raise ConversionError("USX contains unreferenced text outside a verse.")
            pieces.append(element.text)
        elif element.text and verse is not None:
            pieces.append(element.text)
        for child in element:
            walk(child)
            if child.tail:
                if verse is not None:
                    pieces.append(child.tail)
                elif child.tail.strip():
                    raise ConversionError("USX contains text after a verse end and before its next start.")

    walk(root)
    if active_id is not None:
        raise ConversionError("USX contains an unclosed verse milestone.")
    finish()
    return edition.finish()


def docx_text(data, report):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 4096 or sum(e.file_size for e in entries) > MAX_BYTES * 2:
                raise ConversionError("DOCX archive exceeds entry or expanded-size limits.")
            names = [e.filename for e in entries]
            if names.count("word/document.xml") != 1:
                raise ConversionError("DOCX must contain exactly one word/document.xml.")
            if any(e.flag_bits & 1 for e in entries):
                raise ConversionError("Encrypted DOCX archives are not supported.")
            for name in names:
                if name in {"word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"}:
                    report.loss("docx-annotations", "Word notes/comments are not part of the imported verse paragraphs.")
            with archive.open("word/document.xml") as stream:
                raw = stream.read(MAX_BYTES + 1)
            root = xml_root(raw)
    except (zipfile.BadZipFile, RuntimeError) as error:
        raise ConversionError(f"Invalid DOCX archive: {error}") from None
    for element in root.iter():
        if tag(element) in {"del", "ins", "moveFrom", "moveTo", "fldChar", "instrText", "altChunk", "drawing", "pict"}:
            raise ConversionError("Word tracked changes, fields, embedded objects, and drawings need manual review before conversion.")
    lines = []
    for paragraph in root.iter():
        if tag(paragraph) != "p":
            continue
        pieces = []
        for element in paragraph.iter():
            if tag(element) == "t":
                pieces.append(element.text or "")
            elif tag(element) == "tab":
                pieces.append("\t")
            elif tag(element) in {"br", "cr"}:
                pieces.append("\n")
        lines.append("".join(pieces))
    report.event("docx-formatting", "Word paragraph text is imported; visual styles and layout are not retained.")
    return "\n".join(lines)


def run_bounded(argv, env=None):
    try:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    except FileNotFoundError:
        raise ConversionError(f"Required executable {argv[0]!r} was not found; install it separately or export to a supported interchange format.") from None
    output, errors, oversized = bytearray(), bytearray(), []

    def consume(stream, target, limit):
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            if len(target) + len(chunk) > limit:
                oversized.append(True)
                process.kill()
                break
            target.extend(chunk)
        stream.close()

    threads = [threading.Thread(target=consume, args=(process.stdout, output, MAX_BYTES)), threading.Thread(target=consume, args=(process.stderr, errors, 65536))]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise ConversionError("External extractor exceeded the 120-second limit.") from None
    finally:
        for thread in threads:
            thread.join()
    if oversized:
        raise ConversionError("External extractor exceeded its output limit.")
    if process.returncode:
        # Do not echo extractor stderr: it can include document text or keys.
        raise ConversionError(f"External extractor failed with exit status {process.returncode}; inspect the original with its authoring tool.")
    return bytes(output)


def sword_configuration(module, explicit_root=None):
    roots = [Path(explicit_root)] if explicit_root else [Path(p) for p in [os.environ.get("SWORD_PATH"), str(Path.home() / ".sword"), "/usr/share/sword", "/usr/local/share/sword"] if p]
    matches = []
    for root in roots:
        files = sorted((root / "mods.d").glob("*.conf"))
        if len(files) > 4096:
            raise ConversionError("SWORD configuration directory exceeds its file limit.")
        for file in files:
            config = configparser.ConfigParser(interpolation=None, strict=False)
            try:
                config.read_string(decode(read_bytes(file)))
            except configparser.Error:
                raise ConversionError("Malformed SWORD module configuration.") from None
            if module in config:
                matches.append((root, config[module]))
    if len(matches) != 1:
        raise ConversionError("SWORD module must have exactly one matching configuration; specify --sword-path for its installation root.")
    root, configuration = matches[0]
    if "CipherKey" in configuration:
        raise ConversionError("Encrypted/locked SWORD modules are not imported; obtain an authorized unlocked interchange export from the publisher.")
    if configuration.get("ModDrv", "") not in {"RawText", "RawText4", "zText", "zText4"}:
        raise ConversionError("SWORD direct import currently supports Bible text modules; export commentaries to referenced text first.")
    return root


def word_spans(text):
    """Word positions under tokenizer lamplighter-words-1 (lib/word-links.js): runs of letters, marks and
    digits, with apostrophes inside them."""
    inside = lambda ch: unicodedata.category(ch)[0] in "LMN"
    spans, i, n = [], 0, len(text)
    while i < n:
        if not inside(text[i]):
            i += 1
            continue
        j = i
        while True:
            while j < n and inside(text[j]):
                j += 1
            if j + 1 < n and text[j] in "'\u2019" and inside(text[j + 1]):
                j += 1
                continue
            break
        spans.append((i, j))
        i = j
    return spans


def tagged_words(text):
    """Words of a verse from a tag-collecting parse: [(word, "H853 H776" or None, supplied)]."""
    plain, marks, numbers, added, i = [], [], [], 0, 0
    while i < len(text):
        ch = text[i]
        if ch == TAG_OPEN:
            j = text.index(TAG_MID, i)
            numbers.append(text[i + 1:j])
            i = j + 1
            continue
        if ch == TAG_CLOSE:
            numbers.pop()
        elif ch == ADD_OPEN:
            added += 1
        elif ch == ADD_CLOSE:
            added -= 1
        else:
            plain.append(ch)
            marks.append((numbers[-1] if numbers else None, added > 0))
        i += 1
    joined = "".join(plain)
    return [(joined[a:b], *marks[a]) for a, b in word_spans(joined)]


def same_word(word):
    return word.casefold().replace("\u2019", "'")


def build_links(source, target, report):
    """Word links for the target edition from a source parsed with tags: a source word's numbers go to the
    target word it matches in the same verse; words the source marks as supplied link with no number."""
    words = {}
    for book in source["books"]:
        for chapter in book["chapters"]:
            for verse in chapter["verses"]:
                words[(book["osis"], chapter["chapter"], verse["verse"])] = tagged_words(verse["text"])
    verses, linked, total = {}, 0, 0
    # Keys count books in the target edition's own order, as every Lamplighter resource does
    for index, book in enumerate(target.get("books", [])):
        identity = next((book_id(book[f]) for f in ("osis", "abbrev", "name") if isinstance(book.get(f), str) and norm(book[f]) in ALIASES), None)
        if identity is None:
            report.event("unknown-target-book", "Target books with names the converter does not know were skipped.")
            continue
        for c, chapter in enumerate(book.get("chapters", []), 1):
            for v, verse in enumerate(chapter.get("verses", []), 1):
                text = verse.get("text", "") if isinstance(verse, dict) else ""
                spans = word_spans(text)
                total += len(spans)
                found = words.get((identity["osis"], c, v))
                if not found or not spans:
                    continue
                mine = [same_word(text[a:b]) for a, b in spans]
                theirs = [same_word(w) for w, _, _ in found]
                links = []
                for block in difflib.SequenceMatcher(None, theirs, mine, autojunk=False).get_matching_blocks():
                    for k in range(block.size):
                        _, numbers, supplied = found[block.a + k]
                        if numbers is not None:
                            links.append([block.b + k, numbers])
                        elif supplied:
                            links.append([block.b + k, ""])
                if links:
                    links.sort()
                    verses[f"{index}.{c}.{v}"] = links
                    linked += len(links)
    if not verses:
        raise ConversionError("No source words matched the target edition; check that both are the same translation and numbering.")
    report.event("linked-words", f"Words of the target edition that received a Strong's number or a supplied-word mark, of {total}.", linked)
    return {"verses": verses}


def convert(opts):
    report = Report(opts.allow_lossy)
    inputs = opts.inputs
    if len(inputs) > 512:
        raise ConversionError("A conversion accepts at most 512 input files.")
    raw = read_bytes(inputs[0]) if opts.source_format not in {"sword", "usfm", "usx"} else b""
    hashes = [hashlib.sha256(raw).hexdigest()] if opts.source_format not in {"sword", "usfm", "usx"} else []
    reference = load_json(read_bytes(opts.reference_edition)) if opts.reference_edition else None
    if opts.source_format in {"text", "vpl", "docx", "doc"}:
        if opts.source_format == "docx":
            text = docx_text(raw, report)
        elif opts.source_format == "doc":
            text = decode(run_bounded([opts.antiword, "-w", "0", "-m", "UTF-8.txt", str(Path(inputs[0]).resolve())]))
            if hashlib.sha256(read_bytes(inputs[0])).hexdigest() != hashes[0]:
                raise ConversionError("Word source changed during extraction; retry with a stable copy.")
            report.event("doc-extraction", "Legacy Word text was extracted with antiword; inspect line wrapping before importing.")
        else:
            text = decode(raw)
        data = referenced_lines(text, report, opts.kind, reference)
    elif opts.source_format == "lines":
        if not opts.layout:
            raise ConversionError("Unnumbered one-verse-per-line input needs --layout: an edition/skeleton with the exact book/chapter/verse order.")
        data = unnumbered_lines(decode(raw), load_json(read_bytes(opts.layout)), report)
    elif opts.source_format == "json":
        data = normalize_json(load_json(raw), report)
    elif opts.source_format == "osis":
        data = parse_osis(raw, report, tags=bool(opts.links_for))
    elif opts.source_format in {"usfm", "usx"}:
        combined = []
        seen = set()
        total_bytes = total_slots = 0
        for filename in inputs:
            source = read_bytes(filename)
            total_bytes += len(source)
            if total_bytes > MAX_BYTES * 2:
                raise ConversionError("Combined input files exceed 128 MiB.")
            hashes.append(hashlib.sha256(source).hexdigest())
            converted = parse_usfm(decode(source), report, tags=bool(opts.links_for)) if opts.source_format == "usfm" else parse_usx(source, report)
            for book in converted["books"]:
                if book["osis"] in seen:
                    raise ConversionError("A book appears in more than one input; combine its source explicitly first.")
                seen.add(book["osis"])
                total_slots += sum(len(chapter["verses"]) for chapter in book["chapters"])
                if len(seen) > 512 or total_slots > MAX_SLOTS:
                    raise ConversionError("Combined books or expanded verse slots exceed the import limits.")
                combined.append(book)
        data = {"books": combined}
    elif opts.source_format == "sword":
        module = inputs[0]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,127}", module):
            raise ConversionError("SWORD input must be an installed module identifier, not an archive or command option.")
        environment = os.environ.copy()
        environment["SWORD_PATH"] = str(sword_configuration(module, opts.sword_path).resolve())
        raw = run_bounded([opts.mod2osis, module], environment)
        hashes.append(hashlib.sha256(raw).hexdigest())
        data = parse_osis(raw, report, tags=bool(opts.links_for))
        report.event("sword-export", "An installed SWORD module was exported by CrossWire mod2osis; no proprietary/locked-module decoder is included.")
    else:
        raise ConversionError("Unsupported source format.")
    if opts.links_for:
        if opts.source_format not in {"usfm", "osis", "sword"} or opts.kind != "edition":
            raise ConversionError("Word links come from Strong's-tagged USFM, OSIS or SWORD Bible text.")
        target_bytes = read_bytes(opts.links_for)
        target = load_json(target_bytes)
        if any(MARKERS.search(verse.get("text", "")) for book in target.get("books", []) for chapter in book.get("chapters", []) for verse in chapter.get("verses", []) if isinstance(verse, dict)):
            raise ConversionError("Target edition text contains private-use characters this converter reserves.")
        data = build_links(data, target, report)
        data = {"type": "word-links", "formatVersion": 1, "edition": opts.abbreviation or target.get("abbreviation", ""), "editionSha256": hashlib.sha256(target_bytes).hexdigest(), "tokenizer": "lamplighter-words-1", **data}
        for option, field in [("name", "name"), ("license", "license"), ("license_url", "license_url"), ("attribution", "attribution"), ("versification", "versification")]:
            if getattr(opts, option) is not None:
                data[field] = getattr(opts, option)
        data["source"] = {"format": opts.source_format, **({"sha256": hashes[0]} if len(hashes) == 1 else {})}
        summary = {"sourceFormat": opts.source_format, "kind": "word-links", "inputSha256": hashes, "diagnostics": list(report.events.values()), "verses": len(data["verses"])}
        return data, summary
    if opts.kind == "commentary" and opts.source_format not in {"text", "vpl", "docx", "doc"}:
        raise ConversionError("Commentary conversion supports referenced text/Word paragraphs; other formats currently support Bible editions only.")
    for option, field in [("name", "name"), ("abbreviation", "abbreviation"), ("language", "language"), ("language_name", "languageEnglishName"), ("license", "license"), ("license_url", "license_url"), ("attribution", "attribution"), ("versification", "versification")]:
        value = getattr(opts, option)
        if value is not None:
            data[field] = value
    if not data.get("name"):
        raise ConversionError("Supply --name for the converted resource.")
    if opts.rtl:
        data["textDirection"] = "rtl"
    data.setdefault("formatVersion", 1)
    if "source" not in data:
        data["source"] = {"format": opts.source_format, **({"sha256": hashes[0]} if len(hashes) == 1 else {})}
    summary = {"sourceFormat": opts.source_format, "kind": opts.kind, "inputSha256": hashes, "diagnostics": list(report.events.values())}
    if "books" in data:
        summary.update(books=len(data["books"]), chapters=sum(len(b["chapters"]) for b in data["books"]), verses=sum(len(c["verses"]) for b in data["books"] for c in b["chapters"]))
    else:
        summary["entries"] = len(data["entries"])
    return data, summary


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("inputs", nargs="+")
    p.add_argument("--from", dest="source_format", choices=["text", "vpl", "lines", "docx", "doc", "usfm", "usx", "osis", "sword", "json"], required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--report", help="Optional JSON conversion receipt (contains no verse text)")
    p.add_argument("--kind", choices=["edition", "commentary"], default="edition")
    for option in ["name", "abbreviation", "language", "language-name", "license", "license-url", "attribution", "versification", "reference-edition", "layout", "sword-path"]:
        p.add_argument("--" + option)
    p.add_argument("--links-for", metavar="EDITION", help="Write word links for this Lamplighter edition from a Strong's-tagged source instead of an edition")
    p.add_argument("--antiword", default="antiword", help="Path to trusted antiword executable for legacy DOC")
    p.add_argument("--mod2osis", default="mod2osis", help="Path to trusted CrossWire mod2osis executable")
    p.add_argument("--rtl", action="store_true")
    p.add_argument("--allow-lossy", action="store_true")
    p.add_argument("--force", action="store_true", help="Replace an existing output file")
    return p


def main(argv=None):
    opts = parser().parse_args(argv)
    try:
        if len(opts.inputs) > 1 and opts.source_format not in {"usfm", "usx"}:
            raise ConversionError("Multiple inputs are supported only for USFM/USX book files.")
        output = Path(opts.out).resolve()
        sources = [Path(p).resolve() for p in opts.inputs] if opts.source_format != "sword" else []
        sources += [Path(p).resolve() for p in [opts.layout, opts.reference_edition, opts.links_for] if p]
        if output in sources:
            raise ConversionError("Output must differ from every source, layout, and reference file.")
        if opts.report and Path(opts.report).resolve() == output:
            raise ConversionError("Report and output must be different files.")
        if opts.report and Path(opts.report).resolve() in sources:
            raise ConversionError("Report must differ from every source, layout, and reference file.")
        for target in [opts.out, opts.report]:
            if target and Path(target).exists() and not opts.force:
                raise ConversionError("Output/report already exists; use another destination or explicitly pass --force.")
        data, report = convert(opts)
        # Same linter as the app-facing Node CLI, so conversion cannot bypass it.
        encoded = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        validation = subprocess.run(["node", "-e", "const fs=require('fs');const r=require(process.argv[1]).lint(JSON.parse(fs.readFileSync(0,'utf8')));console.log(JSON.stringify(r));process.exit(r.errors.length?1:0)", str(ROOT / "lib/validate.js")], input=encoded, capture_output=True, timeout=120, check=False)
        if validation.returncode:
            raise ConversionError("Converted result failed Lamplighter validation; output was not written. " + decode(validation.stdout)[:2000])
        write_atomic(output, encoded, opts.force)
        report["outputSha256"] = hashlib.sha256(encoded).hexdigest()
        report["validation"] = "passed"
        if opts.report:
            write_atomic(opts.report, (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), opts.force)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (ConversionError, OSError, UnicodeError, json.JSONDecodeError, subprocess.TimeoutExpired, RecursionError) as error:
        print(f"Conversion failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
