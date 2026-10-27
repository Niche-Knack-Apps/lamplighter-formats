# The formats

Everything Lamplighter reads is plain JSON, UTF-8, no byte-order mark. Five kinds of file:
an **edition** (a Bible translation), a **commentary**, **cross-references**, **original-language
words**, and a **lexicon**. The first is what most people make; the others are for study
resources. A large commentary can also travel as a [pack](#commentary-packs), a folder of
small files. `lamplighter-formats lint` tells the kinds apart by their shape. All five kinds,
and the two files of a pack, have Draft-07 schemas in `schemas/`. Use both the schema and the linter: JSON Schema cannot
express array-position numbering, duplicate book names, or the ordering of range endpoints.

Book, chapter and verse numbering: `book_index` counts from 0 in the order the edition lists
its books (Genesis is 0 in the usual canon, Matthew 39, John 42). Chapters and verses count
from 1. Keys of the form `"<book_index>.<chapter>.<verse>"` appear in the study resources:
`"0.1.1"` is Genesis 1:1.

## Version and provenance

Unversioned files remain supported. New tools can add `"formatVersion": 1`; unknown
versions fail validation rather than being interpreted as an older format. The package
version (currently 0.5.x) is separate from the data format version.

The following optional top-level fields do not change the existing reader shape:

| Field | Meaning |
| --- | --- |
| `formatVersion` | Integer `1`; may be omitted for legacy resources. |
| `language`, `languageEnglishName`, `textDirection` | Language identity and `ltr`/`rtl` presentation. ISO 639 codes and BCP 47 language tags can be retained. |
| `license`, `license_url`, `attribution` | Source rights and required credit; conversion does not grant permission to redistribute. |
| `versification` | The source's declared numbering system, such as `KJV`, `NRSVA`, `Leningrad` or `Vulgate`. Metadata does not renumber a resource. See [Versification](#versification). |
| `source` | Provenance object with optional `name`, `url`, `format`, and lowercase `sha256`. |
| `referenceBooks` | Unique source book names in their original index order for commentary references. The reader implementation for 1.11.73 maps recognized book identities into the open edition; older readers may use the numeric indices directly. |

Book objects may include `osis` as a stable book identifier. Legacy `book` and `abbr`
aliases remain accepted alongside `name` and `abbrev`. Unknown extension fields remain
allowed so existing metadata is not discarded. Interchange JSON is plain text; application
vault encryption is a separate storage concern.

## Edition

```json
{
  "name": "World English Bible",
  "abbreviation": "WEB",
  "language": "eng",
  "languageEnglishName": "English",
  "license": "Public Domain",
  "license_url": "https://worldenglish.bible/",
  "attribution": "",
  "textDirection": "ltr",
  "books": [
    {
      "name": "Genesis",
      "abbrev": "Gen",
      "chapters": [
        {
          "chapter": 1,
          "verses": [
            { "verse": 1, "text": "In the beginning, God created the heavens and the earth." },
            { "verse": 2, "text": "The earth was formless and empty. …" }
          ]
        }
      ]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The edition's full name, as readers see it. |
| `abbreviation` | recommended | A short label (`WEB`, `KJV`). |
| `language` | recommended | ISO 639-3 code (`eng`, `spa`, `swh`). |
| `languageEnglishName` | recommended | The language's name in English; the Library filters by it. |
| `license` | recommended | The terms in a few words: `Public Domain`, `CC BY 4.0`, `CC BY-SA 4.0`, … |
| `license_url` | optional | Where the full terms are. The app links it from the footer. |
| `attribution` | optional | A credit line the license requires. The app shows it in the footer while the edition is read. |
| `textDirection` | optional | `ltr` (default) or `rtl` for Hebrew, Arabic or Syriac scripts. |
| `books[]` | yes | In reading order. Any canon: 66, 73, 27, one book, or a new order. |
| `books[].name` | yes | The book's name in the edition's language. |
| `books[].abbrev` | optional | A short form readers may type to find the book. |
| `books[].chapters[]` | yes | In order. `chapter` is its number, 1-based (optional; order is what counts). |
| `chapters[].verses[]` | yes | In order. `verse` is its number, 1-based (optional); `text` is the verse. |

Rules the linter enforces:

- For compatibility with released readers, chapters and verses use **dense positions**:
  the first verse object is verse 1, the second verse 2. If the edition leaves a verse out,
  keep its place with `{ "verse": 7, "text": "" }`.
  A `verse` or `chapter` number that disagrees with its position is an error.
- `text` is a string. Footnote markers, headings and formatting are not part of the text;
  keep the words only.
- A book name appears once.

`convert --from json` creates a normalized copy of a sparse edition, preserving supplied
verse objects/text exactly and inserting empty positions for absent numbers. It rejects
duplicate, invalid, or unreasonably large numbers. This does not reconstruct missing
wording or harmonize one versification with another. See [CONVERTING.md](CONVERTING.md).

Notes the linter offers (warnings, not faults): a chapter or verse count that differs from the
King James versification, right-to-left text without `"textDirection": "rtl"`, missing
`license`, verses with empty text, and numbering that matches no known scheme or contradicts
the declared `versification`.

### Versification

Editions number some verses differently. Hebrew numbering counts most psalm titles as verse 1
and ends Malachi at 3:24 (English 4:6); the Vulgate joins Psalms 9 and 10. Lamplighter maps
notes, cross-references and original-language words between three schemes: English (KJV,
RSV, NRSV), Original (Hebrew and Greek) and Vulgate. It uses `versification` when an
edition declares one it knows, and otherwise recognizes the scheme from the edition's own
chapter and verse counts. `lint` and `info` report the scheme they recognize. The reader implementation for 1.11.74 uses this same engine; older reader versions may compare verse numbers directly.

Unknown schemes keep their source numbers and must be shown as unmapped where numbering differs. These tables are not a complete equivalence for every canon: SIL's English data has no special mapping for 2 Corinthians 13, and the generator reports skipped Greek Esther half-verse segments, a 6 Ezra segment, and a backwards Daniel range. Do not silently invent a mapping. Stored study references use KJV numbering; a psalm title with no KJV verse is chapter-only.

The mapping tables are SIL's, from libpalaso (MIT), kept unmodified in `data/versification/`.
`scripts/build-versification.py` turns them into `lib/versification-data.js`, which
`lib/versification.js` reads. That file works as a Node module and as a browser script.

A full-size edition is 4–8 MB. The app loads it once and caches the parsed form.

## Commentary

```json
{
  "name": "A Study Commentary",
  "type": "commentary",
  "entries": [
    {
      "range": { "start": { "book": "Genesis", "book_index": 0 }, "end": { "book": "Genesis", "book_index": 0 } },
      "content": "A note on the whole book."
    },
    {
      "range": { "start": { "book": "Genesis", "book_index": 0, "chapter": 1, "verse": 1 },
                 "end":   { "book": "Genesis", "book_index": 0, "chapter": 1, "verse": 2 } },
      "content": "A note on Genesis 1:1-2."
    }
  ]
}
```

Each entry covers a range: a whole book (`book_index` only), a chapter (`chapter` only), or
verses (`chapter` and `verse`). `end` may be left out for a single point. `content` is plain
text; paragraphs are separated by blank lines. The app shows the entries whose range covers
the verses the reader selected. Book introductions appear in chapter 1 and sort first; other matches are ordered by specificity.

An optional `title` string labels an entry. Each supplied range endpoint needs a nonnegative
`book_index`; a verse also needs its chapter. The end cannot precede the start. Converters
require a reference edition for commentary so an NT-only or differently ordered Bible does
not accidentally receive indices from a 66-book Bible.

## Commentary packs

A full commentary can run to 50 MB, more than a phone should hold in memory at once. A pack
keeps the same commentary as a folder: `pack.json` lists the parts, and each part file holds
the entries for one book or a run of chapters. A reader opens `pack.json`, loads the parts that
cover the passage on screen, and drops parts it no longer needs.

```
gill/
  pack.json
  000-gen-001-023.json
  000-gen-024-050.json
  000-gen-book.json
  001-exo.json
  …
```

`pack.json` carries the commentary's own fields (`name`, `license`, `attribution`,
`versification`, `referenceBooks` and the rest, as above) with these in place of `entries`:

```json
{
  "name": "A Study Commentary",
  "type": "commentary-pack",
  "formatVersion": 1,
  "license": "Public Domain",
  "entryCount": 3,
  "parts": [
    {
      "file": "000-gen.json",
      "range": { "start": { "book": "Genesis", "book_index": 0 }, "end": { "book": "Genesis", "book_index": 0 } },
      "entryCount": 2,
      "bytes": 375,
      "sha256": "1a375b617cfc2ed22637ff5d6c6bd23b658ca2750137828054eb3799947a1922"
    },
    {
      "file": "042-jhn.json",
      "range": { "start": { "book": "John", "book_index": 42, "chapter": 1 }, "end": { "book": "John", "book_index": 42, "chapter": 1 } },
      "entryCount": 1,
      "bytes": 214,
      "sha256": "7753a7b9e63d3e75c300c9541f3b740ee1d4b9d4972aa9b5623ee6fe7a4a5d66"
    }
  ]
}
```

This is `templates/commentary-pack.sample/`, made by `pack` from `templates/commentary.sample.json`.

A part file holds entries exactly as a commentary does:

```json
{ "type": "commentary-part", "formatVersion": 1, "entries": [ { "range": { … }, "content": "…" } ] }
```

| Field | Meaning |
| --- | --- |
| `type` | `commentary-pack` in `pack.json`, `commentary-part` in a part. |
| `formatVersion` | `1`, required in both. |
| `entryCount` | Entries in the whole pack: the sum of the parts' counts. |
| `parts[].file` | The part's file name in the same folder: letters, digits, `.`, `_` and `-`, ending `.json`. No folders. Names are labels; `pack.json` is what a reader goes by. |
| `parts[].range` | From the earliest start to the latest end of the part's entries, in the commentary's own numbering. Every entry in the part lies inside it. |
| `parts[].entryCount` | Entries in the part. |
| `parts[].bytes`, `parts[].sha256` | The part file's size and SHA-256 exactly as stored. A reader checks both before using a part, and they let a device that imports files one at a time (a phone that cannot pick a folder) match each part to the manifest. |

A reader needs every part whose range overlaps the passage (`partsFor` in `lib/pack.js`). Part
ranges may overlap: a note running past a chapter break stays in the part where it starts,
and that part's range reaches as far as the note does. Entries that start at the same place
are always in the same part, in their original order.

`lamplighter-formats pack` puts each book in one part. A book larger than the limit (2 MiB by
default; `--max-part-bytes`) becomes a part of its book-level entries plus evenly sized runs of
whole chapters, and a chapter larger than the limit is split between verses. Within a part,
entries are in reading order by where they start. `unpack` checks a pack and joins it back
into one commentary file. `lint` and `info` take the pack's folder or its `pack.json`: they
check every part against the manifest and point out JSON files in the folder that `pack.json`
does not list.

Released Lamplighter readers look for `"type": "commentary"` with `entries`, so they pass over
both files of a pack. No released version reads packs yet; until one does, `unpack` gives the
single file they take.

## Cross-references

```json
{
  "meta": { "id": "my_refs", "name": "My Cross-References", "source": "you", "license": "CC BY", "type": "cross_reference" },
  "refs": {
    "0.1.1": [ { "ref": "42.1.1", "weight": 10, "endRef": "42.1.3" }, { "ref": "57.11.3", "weight": 5 } ]
  }
}
```

`refs` maps a verse key to the verses it points at. `weight` orders them (higher first);
`endRef` makes the target a range. Keys and refs are `"<book_index>.<chapter>.<verse>"`.

## Original-language words

```json
{
  "meta": { "source": "SBLGNT", "wordCount": 137554, "verseCount": 7927 },
  "verses": {
    "39.1.1": [
      { "word": "Βίβλος", "lemma": "βίβλος", "strongs": "G976", "pos": "N-", "morph": "----NSF-", "morphDesc": "Noun Nominative Singular Feminine", "wordIndex": 0 }
    ]
  }
}
```

One array per verse, in word order. `strongs` is a Strong's number (`G…` Greek, `H…` Hebrew);
`morph` and `morphDesc` describe the form. The app's bundled files are the SBL Greek New
Testament and the Open Scriptures Hebrew Bible.

## Lexicon

```json
{
  "meta": { "source": "Strong's Greek Dictionary", "entries": 5624 },
  "entries": {
    "G976": { "strongs": "G976", "word": "βίβλος", "translit": "biblos", "pron": "bib'-los", "derivation": "…", "def": "a roll, book", "kjvDef": "--bible, book, scroll." }
  }
}
```

Keyed by Strong's number; `def` is the definition the app shows.

## Where files go

- Desktop: Settings → Library → *Add translation folder* (editions) or *Add commentary folder*.
  Keep a commentary pack in a folder of its own, with nothing else in it.
- Any device: publish to an OCI registry with `scripts/oci-editions.py push` and add the
  registry in Settings → Library. The app keeps an opened edition on the device.
- Lamplighter's own bundled editions are the same format, in the app's `renderer/bundled/`.
