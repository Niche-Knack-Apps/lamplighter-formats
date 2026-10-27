# lamplighter-formats

[![ci](https://github.com/Niche-Knack-Apps/lamplighter-formats/actions/workflows/ci.yml/badge.svg)](https://github.com/Niche-Knack-Apps/lamplighter-formats/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> The JSON that Lamplighter reads: schemas, validation, conversion tools, templates,
> new-language skeletons, and a publisher for any OCI registry.

Made by [Niche-Knack](https://nk.tools) — Smart Tools. Sharp Solutions.

> **Simple by design.** A Bible edition for Lamplighter is one plain JSON file: books, chapters,
> verses, text. It needs no proprietary file type, no tooling you cannot read, and no account.
> New languages for new people groups can be created and added easily: start a skeleton with
> every verse in place, fill in the text, lint it, and the app reads it.

## What is here

| Path | What it is |
| --- | --- |
| [`FORMATS.md`](FORMATS.md) | The formats, each with a complete minimal example: editions, commentaries, commentary packs, cross-references, original-language words, lexicons. |
| `schemas/` | JSON Schema (draft-07) for editions, commentaries, commentary packs and their parts, cross-references, original-language words, and lexicons. |
| `bin/lamplighter-formats.js` | The command line: `lint`, `new`, `info`, `convert`, `pack` and `unpack`. Node 18 or newer; conversion also needs Python 3.10 or newer. |
| [`CONVERTING.md`](CONVERTING.md) | Import Word documents, referenced or unnumbered verse lines, USFM, USX, OSIS, and installed SWORD Bible modules. |
| `lib/` | The same checks as a library (`validate.js`), the skeleton builder (`skeleton.js`), the King James versification (`canon.json`), verse mapping between numbering schemes (`versification.js`), and commentary packs (`pack.js`). |
| `data/versification/` | SIL's versification tables (MIT), unmodified; `scripts/build-versification.py` generates `lib/versification-data.js` from them. |
| `templates/` | A small sample of each kind, lint-clean, to copy from. |
| `vendor/bible-model.js` | Lamplighter's own reader model, so a test can prove a file loads exactly as the app loads it. |
| `scripts/oci-editions.py` | Publish editions to any OCI registry (a zot server, for instance) and read them back. Python 3, standard library only. |
| `tests/` | Parser, validation, safety, numbering, and reader-compatibility checks using synthetic text. |

## Quick start

```sh
git clone https://github.com/Niche-Knack-Apps/lamplighter-formats
cd lamplighter-formats
npm test

# Check a file the way the app reads it
node bin/lamplighter-formats.js lint my-edition.json

# Start an edition in a new language: every book, chapter and verse in place, texts empty
node bin/lamplighter-formats.js new "Nuevo Testamento Sencillo" --out nts.json \
  --abbreviation NTS --language spa --language-name Spanish --license "CC BY 4.0" --books nt

# Counts and facts
node bin/lamplighter-formats.js info nts.json

# Split a large commentary into a folder of small parts a reader loads as needed, and back
node bin/lamplighter-formats.js pack commentary.json --out commentary-pack
node bin/lamplighter-formats.js lint commentary-pack
node bin/lamplighter-formats.js unpack commentary-pack --out commentary.json

# Convert referenced verse lines, preserving Unicode and numbered gaps
node bin/lamplighter-formats.js convert translation.txt --from vpl \
  --name "My Translation" --language eng --license "CC BY 4.0" \
  --out translation.json --report conversion.json

# Word paragraphs use the same explicit references
node bin/lamplighter-formats.js convert translation.docx --from docx \
  --name "My Translation" --out translation.json
```

`npm link` puts `lamplighter-formats` on your PATH if you prefer.

The converter uses Python's standard library. Legacy `.doc` extraction additionally
requires `antiword`; installed SWORD modules require CrossWire's `mod2osis` utility.
These dependencies are optional and are never downloaded automatically. See
[conversion examples and supported subsets](CONVERTING.md) before converting rich markup.

## Adding a translation to Lamplighter

1. Make the file: start from `templates/edition.sample.json` or `lamplighter-formats new`.
2. Fill in the verse text. Keep every verse number in place; a verse the edition leaves out
   keeps an empty `"text"`. Set `"textDirection": "rtl"` for Hebrew, Arabic or Syriac scripts.
3. State the `license` and, when the license asks for it, the `attribution` line. The app
   shows the attribution in the footer while the edition is read.
4. `lamplighter-formats lint the-file.json` until it reports no errors. Warnings are notes;
   a canon with a different chapter or verse count is allowed.
5. Read it: on desktop, Settings → Library → *Add translation folder* and point at the folder
   holding the file. On any device, publish it to a registry (below) and add that registry
   in Settings → Library.

## Publishing to a registry

Editions travel as OCI artifacts, the same way container images do, so any registry can
hold them: a zot server on a church's own hardware, a hosted registry, anything that speaks
the OCI distribution API.

```sh
# Push one or more editions; the index at <prefix>/index:latest lists them
python3 scripts/oci-editions.py push oci://registry.example.com/lamplighter nts.json kjv.json

# See what a registry holds, or pull one back
python3 scripts/oci-editions.py catalog oci://registry.example.com/lamplighter
python3 scripts/oci-editions.py pull oci://registry.example.com/lamplighter nts --out nts.json
```

Use `http://host:5000/prefix` for a registry on the LAN without TLS, and `--user`/`--password`
(or `OCI_USER`/`OCI_PASSWORD`) when the registry asks. Readers add the same `oci://…` address in
Lamplighter's Settings → Library; opening an edition keeps it on their device.

The artifact types are `application/vnd.nicheknack.lamplighter.edition.v1` (one JSON layer,
`…edition.v1+json`, and a small config blob with the facts the app lists an edition by) and
`application/vnd.nicheknack.lamplighter.index.v1` for the index. `oras` reads and writes the
same artifacts.

## Contributing

Pull requests are welcome: a new language, a fix to the checks, a clearer sentence. Run
`npm test` and `npm run lint:templates` before sending one. For the JSON Schema checks,
install `requirements-dev.txt` into a Python virtual environment, then run
`npm run test:schemas`. Keep `VERSION` and `package.json` in sync and bump the version
so the release check passes. The converter fixtures contain synthetic text; do not add
copyrighted translations to this repository as test data.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Bible texts keep their own licenses.

## Support

Really believe in this project's potential and want to contribute to its development?
[Buy Me a Coffee](https://buymeacoffee.com/nicheknack).
