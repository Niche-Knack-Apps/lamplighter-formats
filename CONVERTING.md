# Converting resources to Lamplighter JSON

Use Node 18+ and Python 3.10+. `convert` keeps the existing edition/commentary structure,
checks the result with the same linter as `lint`, and writes a new file. Input files are
never changed. Existing destinations require `--force`; an output/report cannot replace
an input, layout, or reference edition.

```sh
node bin/lamplighter-formats.js convert --help
```

Every conversion prints a receipt with source/output SHA-256 hashes, resource counts,
and diagnostics. Add `--report receipt.json` to save it. Receipts omit verse and note
contents. Output is deterministic: it contains no current timestamp or local file paths.
Supply `--name`, and retain rights/language information with `--license`, `--license-url`,
`--attribution`, `--language`, `--language-name`, `--versification`, and `--rtl` as needed.

## Referenced text and commentary

`text` and `vpl` accept UTF-8, one referenced verse per line. English names, supported
OSIS identifiers, and USFM book codes work. A tab can separate the reference and text:

```text
John 1:1 A synthetic first verse.
John 1:3 A synthetic third verse.
```

```sh
node bin/lamplighter-formats.js convert verses.txt --from vpl \
  --name "My Translation" --out translation.json --report receipt.json
```

The output includes an empty verse 2, preserving verse 3's reference. It does not guess
missing words, infer a different numbering system, or collapse two books with similar
names. Duplicate references fail. Blank lines between referenced records are ignored.
Unsupported book IDs fail explicitly; `lib/book-ids.json` lists the supported IDs.

For commentary, use one reference and note per line. A tab is required for whole-book
or chapter references. Literal `\n` sequences in a note become paragraph line breaks.
References may be a book, a chapter, a verse, or a same-chapter verse range:

```text
Genesis\tA synthetic introduction to the book.
Genesis 1\tA synthetic chapter note.
Genesis 1:1-3\tA synthetic note.\n\nAnother paragraph.
```

In that example, replace `\t` with an actual tab. The reference edition determines the
book indices; this prevents an NT-only or differently ordered translation from receiving
incorrect note references.

```sh
node bin/lamplighter-formats.js convert notes.txt --from text --kind commentary \
  --reference-edition translation.json --name "Study Notes" --out commentary.json
```

Cross-chapter ranges, custom localized book aliases without recognized IDs, and prose
without explicit references need editorial preparation. Commentary import currently uses
referenced text or Word paragraphs; OSIS/SWORD commentary and TEI lexicon conversion are
not implemented. Existing JSON study resources can still be validated against their schemas.

## Unnumbered one-verse-per-line text

Unnumbered lines require an exact layout. They must never be guessed to follow KJV or
another canon. Create or provide a skeleton edition with the expected chapter/verse order:

```sh
node bin/lamplighter-formats.js new "Translation layout" --books nt --out layout.json
node bin/lamplighter-formats.js convert lines.txt --from lines --layout layout.json \
  --name "My Translation" --out translation.json
```

The line count must exactly match the layout's verse count. Internal blank lines count as
empty verses; they are not removed. A conventional final newline does not create a verse.
The bundled skeleton uses KJV numbering; provide your own layout for another versification.

## Word documents

A `.docx` document uses the same referenced-line layout, with one verse or commentary
record per paragraph. Text spread across Word runs is joined in order. Tabs are preserved;
manual line breaks create additional input lines, which also need explicit references.
Visual styles and page layout are not retained. For commentary paragraphs inside one
record, use the documented literal `\n` escape.

```sh
node bin/lamplighter-formats.js convert translation.docx --from docx \
  --name "My Translation" --out translation.json
node bin/lamplighter-formats.js convert study.docx --from docx --kind commentary \
  --reference-edition translation.json --name "Study Notes" --out notes.json
```

Legacy binary `.doc` uses the separately installed `antiword` executable:

```sh
node bin/lamplighter-formats.js convert translation.doc --from doc \
  --name "My Translation" --out translation.json
```

Use `--antiword /path/to/antiword` for an explicit trusted executable. Some small or unusual
Word files are unsupported by antiword; save them as DOCX in Word/LibreOffice first.
Password-protected documents require an authorized unlocked export. Tracked changes,
fields, embedded objects, and drawings in DOCX fail for manual review; the converter never
executes document macros. Notes/comments require explicit `--allow-lossy` acceptance and
are excluded from verse text. Use paragraph-based content; complex tables/text boxes and
automatic numbering should be flattened and reviewed in the authoring application first.

On Debian/Ubuntu, install the optional native extractors with:

```sh
sudo apt install antiword libsword-utils
```

Other platforms can install antiword and the SWORD utilities through their package manager
or the upstream projects. DOCX, text, USFM, USX, and OSIS need neither native extractor.

## USFM and USX

Pass book files in the desired reading order:

```sh
node bin/lamplighter-formats.js convert 01GEN.usfm 02EXO.usfm --from usfm \
  --name "My Translation" --out translation.json --report receipt.json
node bin/lamplighter-formats.js convert 01GEN.usx 02EXO.usx --from usx \
  --name "My Translation" --out translation.json
```

Supported content includes book IDs, numbered chapters/verses, standard text/poetry
paragraphs, and ordinary inline character markup. Formatting is flattened while words are
retained; word attributes such as lemma/Strong's data are not turned into a parallel
original-language resource (see [word links](#word-links-from-strongs-tagged-text) for
Strong's numbers). Unknown markers/elements, alternate numbers, subverse labels,
tables, sidebars, arbitrary extensions, and malformed/unmatched milestones fail explicitly. This
is a checked import subset, not a full USFM/USX implementation.

Headings, introductions, notes, cross-reference annotations, and figures are outside the
plain verse field. The default refuses to omit them. `--allow-lossy` permits supported
omissions and reports each category/count. It also permits a USFM/USX or VPL verse bridge
such as `1-3`: the combined wording stays at verse 1, with empty positions 2 and 3 and a
`sourceVerse` label. It never invents a division of that wording. Review the receipt and
the resulting reader display before distributing a converted text.

## OSIS and SWORD

OSIS Bible imports support container verses and properly paired verse milestones,
including paragraph/poetry text and inline words:

```sh
node bin/lamplighter-formats.js convert bible.osis.xml --from osis \
  --name "My Translation" --out translation.json
```

OSIS headings/notes/figures/reference annotations require `--allow-lossy` to omit. Combined
or subverse OSIS IDs and unsupported elements fail for review. OSIS implicit quotation
mark generation and elaborate milestone/typographic semantics are not reconstructed;
prefer an export with literal punctuation when exact punctuation matters.

SWORD binary modules use CrossWire's own engine via `mod2osis`, installed separately
(often packaged as `libsword-utils` on Linux). Pass an installed module ID, not a ZIP:

```sh
node bin/lamplighter-formats.js convert MyBible --from sword \
  --sword-path /path/to/sword --name "My Bible" \
  --out my-bible.json --report receipt.json
```

The root contains `mods.d/*.conf` and `modules/`. If `--sword-path` is omitted, standard
SWORD installation roots are checked. `--mod2osis /path/to/mod2osis` selects an explicit
trusted executable. Supported module drivers are RawText/RawText4/zText/zText4. Ambiguous,
locked/encrypted, or non-Bible modules fail; this tool does not bypass module protection.
An alternative is `mod2osis MyBible > my-bible.osis.xml`, then `--from osis`.

SWORD and e-Sword are different formats. e-Sword/MySword databases and arbitrary binary
archives are not supported by this converter.

## Word links from Strong's-tagged text

A source that tags its words with Strong's numbers (USFM `\w word|strong="H7225"\w*`, OSIS
`<w lemma="strong:H7225">`, or an installed SWORD module with Strong's) gives
[word links](FORMATS.md#word-links) for an edition you already have:

```sh
node bin/lamplighter-formats.js convert 02GEN.usfm 03EXO.usfm --from usfm \
  --links-for kjv.json --abbreviation KJV --license "Public Domain" \
  --allow-lossy --out kjv.links.json
```

Within each verse, the source's words are matched to the edition's words in order, ignoring
case, so the two can differ in punctuation, spelling of a few words, or headings. A matched
word takes the source's numbers. A word inside USFM `\add` or OSIS
`<transChange type="added">` links with `""` (supplied by the translators). Words that do not
match stay unlinked, and the reader projects them instead. The source and the edition must
be the same translation and use the same verse numbering. The receipt counts the linked
words.

Tags describe someone's translation work. Check the source's license before you distribute
the links.

## Normalize existing JSON without changing supplied text

```sh
node bin/lamplighter-formats.js convert sparse.json --from json \
  --out normalized.json --report normalization.json
node bin/lamplighter-formats.js lint normalized.json
```

Existing chapter/verse numbers are honored, or their positions are used when numbers are
omitted. Missing slots become empty objects; supplied text and extension fields are
preserved. Duplicates, invalid numbers, and verse ranges are rejected. Bounds are 1,000
chapters/verses per containing array, 512 books, and 2,000,000 expanded verse slots.
These are resource limits, not an assertion that every canon has KJV's counts.

## Validation and resource limits

Input files are limited to 64 MiB; multiple-book imports accept at most 512 files and
128 MiB combined. XML depth/elements and DOCX expanded size/entry count
are bounded. XML DTD/entity declarations are rejected. DOCX members are read directly
without extracting archive paths or fetching external relationships. External extractors
have output/time limits and run as argument arrays, never through a shell. Use trusted
versions of those separately installed tools for untrusted documents.

JSON Schema and semantic checks can also be run against an external corpus, without
changing its files or copying content into this repository:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
npm run test:schemas
python scripts/audit-corpus.py /path/to/resources --out corpus-receipt.json
```

The corpus audit checks normalized copies in memory and proves each supplied verse object
survives unchanged. Its passing result applies to those normalized copies; it does not
claim a sparse original is already portable or write repaired copies back over originals.

## Format references

- [USFM/USX documentation](https://docs.usfm.bible/usfm/3.1.1/index.html)
- [CrossWire OSIS Bible structure and milestones](https://wiki.crosswire.org/OSIS_Bibles)
- [CrossWire OSIS book identifiers](https://wiki.crosswire.org/OSIS_Book_Abbreviations)
- [CrossWire module development and export tools](https://wiki.crosswire.org/DevTools:Modules)
- [SWORD engine source and utilities](https://www.crosswire.org/sword/develop/index.jsp)
