import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("converter", ROOT / "scripts/convert.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def docx(xml, extra=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", xml)
        for key, value in (extra or {}).items():
            archive.writestr(key, value)
    return data.getvalue()


class ConversionTests(unittest.TestCase):
    def test_referenced_text_preserves_unicode_and_numbers(self):
        report = c.Report()
        data = c.referenced_lines("John 1:1 Λόγος שלום\nJohn 1:3 Third verse\n", report)
        verses = data["books"][0]["chapters"][0]["verses"]
        self.assertEqual([v["text"] for v in verses], ["Λόγος שלום", "", "Third verse"])
        self.assertEqual(report.events["missing-verse-slots"]["count"], 1)

    def test_duplicates_invalid_books_and_references_fail(self):
        for text in ["John 1:1 First\nJohn 1:1 Second", "Unknown 1:1 Text", "John 0:1 Text", "John 1:1001 Text", "John 1:2a Text"]:
            with self.subTest(text=text), self.assertRaises(c.ConversionError):
                c.referenced_lines(text, c.Report())

    def test_verse_bridge_requires_explicit_loss_consent(self):
        with self.assertRaisesRegex(c.ConversionError, "allow-lossy"):
            c.referenced_lines("John 1:1-2 Combined words", c.Report())
        report = c.Report(True)
        verses = c.referenced_lines("John 1:1-2 Combined words", report)["books"][0]["chapters"][0]["verses"]
        self.assertEqual(verses, [{"verse": 1, "text": "Combined words", "sourceVerse": "1-2"}, {"verse": 2, "text": ""}])
        self.assertIn("verse-bridge", report.events)

    def test_commentary_uses_reference_edition_book_order(self):
        reference = {"books": [{"name": "John"}, {"name": "Genesis"}]}
        data = c.referenced_lines("John 1:1-3\tA paragraph.\\n\\nAnother paragraph.\nGenesis\tBook introduction.", c.Report(), "commentary", reference)
        self.assertEqual(data["entries"][0]["range"]["start"]["book_index"], 0)
        self.assertEqual(data["entries"][0]["range"]["end"]["verse"], 3)
        self.assertEqual(data["entries"][1]["range"]["start"], {"book": "Genesis", "book_index": 1})
        self.assertIn("\n\n", data["entries"][0]["content"])
        with self.assertRaises(c.ConversionError):
            c.referenced_lines("John 1:1 Note", c.Report(), "commentary")
        with self.assertRaises(c.ConversionError):
            c.referenced_lines("John 1:3-1 Note", c.Report(), "commentary", reference)

    def test_json_padding_preserves_original_fields_and_source(self):
        original = {"name": "Example", "custom": {"value": 5}, "books": [{"name": "John", "localName": "Yohanan", "chapters": [{"chapter": 2, "label": "two", "verses": [{"verse": 3, "text": "Original  spaces", "annotation": "retained"}]}]}]}
        output = c.normalize_json(original, c.Report())
        self.assertEqual(original["books"][0]["chapters"][0]["chapter"], 2)
        self.assertEqual(output["books"][0]["chapters"][0], {"chapter": 1, "verses": []})
        self.assertEqual(output["books"][0]["chapters"][1]["verses"][2], original["books"][0]["chapters"][0]["verses"][0])
        self.assertEqual(output["custom"], original["custom"])

    def test_json_rejects_duplicates_and_enormous_sparse_numbers(self):
        for verses in [[{"verse": 1, "text": "A"}, {"verse": 1, "text": "B"}], [{"verse": 10**9, "text": "A"}], [{"verse": True, "text": "A"}], [{"verse": "1-2", "text": "A"}], [{"verse": "1", "text": "A"}]]:
            with self.subTest(verses=verses), self.assertRaises(c.ConversionError):
                c.normalize_json({"books": [{"name": "John", "chapters": [{"verses": verses}]}]}, c.Report())

    def test_json_rejects_duplicate_properties_and_non_json_numbers(self):
        for value in [b'{"text":"first","text":"second"}', b'{"text": NaN}', b'{"value": Infinity}']:
            with self.subTest(value=value), self.assertRaises(c.ConversionError):
                c.load_json(value)

    def test_atomic_replacement_preserves_a_source_hardlink(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source", Path(directory) / "output"
            source.write_bytes(b'original')
            os.link(source, output)
            c.write_atomic(output, b'new result', force=True)
            self.assertEqual(source.read_bytes(), b'original')
            self.assertEqual(output.read_bytes(), b'new result')
            with self.assertRaises(FileExistsError):
                c.write_atomic(output, b'overwrite', force=False)
            self.assertEqual(output.read_bytes(), b'new result')
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['output', 'source'])

    def test_unreferenced_lines_need_exact_layout_and_preserve_empty_lines(self):
        layout = {"name": "Example", "books": [{"name": "John", "chapters": [{"verses": [{"text": ""}] * 3}]}]}
        result = c.unnumbered_lines("First\n\nThird\n", layout, c.Report())
        self.assertEqual([v["text"] for v in result["books"][0]["chapters"][0]["verses"]], ["First", "", "Third"])
        with self.assertRaisesRegex(c.ConversionError, "exactly 3"):
            c.unnumbered_lines("First\nThird", layout, c.Report())
        result = c.unnumbered_lines("First\u2028part\r\n\r\nThird\r\n", layout, c.Report())
        self.assertEqual(result['books'][0]['chapters'][0]['verses'][0]['text'], 'First\u2028part')

    def test_osis_container_and_milestone_verses(self):
        container = b'<osis><osisText><div type="book" osisID="John"><chapter osisID="John.1"><verse osisID="John.1.1">First <hi>word</hi> tail.</verse><verse osisID="John.1.3">Third.</verse></chapter></div></osisText></osis>'
        milestone = b'<osis><osisText><p><verse sID="John.1.1" osisID="John.1.1"/>First <hi>word</hi> tail.<verse eID="John.1.1"/><verse sID="John.1.3" osisID="John.1.3"/>Third.<verse eID="John.1.3"/></p></osisText></osis>'
        self.assertEqual(c.parse_osis(container, c.Report()), c.parse_osis(milestone, c.Report()))

    def test_osis_annotation_never_becomes_verse_text(self):
        xml = b'<osis><verse osisID="Gen.1.1">First <note>Secret note</note>word.</verse></osis>'
        with self.assertRaises(c.ConversionError):
            c.parse_osis(xml, c.Report())
        data = c.parse_osis(xml, c.Report(True))
        self.assertEqual(data["books"][0]["chapters"][0]["verses"][0]["text"], "First word.")

    def test_osis_rejects_mismatched_or_unclosed_milestones(self):
        for xml in [b'<osis><verse sID="Gen.1.1"/>A<verse eID="Gen.1.2"/></osis>', b'<osis><verse sID="Gen.1.1"/>A</osis>', b'<osis><verse osisID="Gen.1.1 Gen.1.2">A</verse></osis>', b'<osis><verse osisID="Gen.1.1"><unknown>A</unknown></verse></osis>']:
            with self.subTest(xml=xml), self.assertRaises(c.ConversionError):
                c.parse_osis(xml, c.Report())

    def test_osis_unreferenced_text_and_implicit_quotes_need_consent(self):
        for xml in [b'<osis>Unreferenced words<verse osisID="Gen.1.1">A</verse></osis>', b'<osis><verse osisID="Gen.1.1"><q>A</q></verse></osis>']:
            with self.subTest(xml=xml), self.assertRaises(c.ConversionError):
                c.parse_osis(xml, c.Report())
        result = c.parse_osis(b'<osis><verse osisID="Gen.1.1"><q marker="&quot;">Words</q>.</verse></osis>', c.Report())
        self.assertEqual(result['books'][0]['chapters'][0]['verses'][0]['text'], '"Words".')
        with self.assertRaises(c.ConversionError):
            c.parse_osis(b'<osis><unknown><verse osisID="Gen.1.1">A</verse></unknown></osis>', c.Report())
        with self.assertRaises(c.ConversionError):
            c.parse_osis(b'<osis><figure src="illustration.png"/><verse osisID="Gen.1.1">A</verse></osis>', c.Report())

    def test_xml_entity_and_deep_nesting_are_rejected(self):
        for xml in [b'<!DOCTYPE osis [<!ENTITY x "expanded">]><osis>&x;</osis>', '<!DOCTYPE osis><osis/>'.encode('utf-16'), ("<a>" * 129 + "</a>" * 129).encode()]:
            with self.subTest(xml=xml[:50]), self.assertRaises(c.ConversionError):
                c.xml_root(xml)

    def test_usfm_multiline_unicode_and_inline_words(self):
        text = '\\id JHN\n\\c 1\n\\p\n\\v 1 First \\w λόγος|lemma="λόγος"\\w* here.\n\\q1 Continues.\n\\v 3 Third.'
        result = c.parse_usfm(text, c.Report())
        self.assertEqual(result["books"][0]["chapters"][0]["verses"][0]["text"], "First λόγος here. Continues.")
        self.assertEqual(len(result["books"][0]["chapters"][0]["verses"]), 3)

    def test_usfm_rejects_unknown_unbalanced_and_unnumbered_content(self):
        for text in ['\\id JHN\\c 1\\v 1 Text\\zzz Lost', '\\id JHN\\c 1\\v 1 \\it Text', '\\id JHN\\c 1 Unnumbered', '\\id JHN\\v 1 Text']:
            with self.subTest(text=text), self.assertRaises(c.ConversionError):
                c.parse_usfm(text, c.Report())

    def test_usfm_notes_are_explicitly_lossy(self):
        text = '\\id JHN\\c 1\\v 1 Words\\f + \\ft Footnote text\\f* continue.'
        with self.assertRaises(c.ConversionError):
            c.parse_usfm(text, c.Report())
        result = c.parse_usfm(text, c.Report(True))
        self.assertEqual(result["books"][0]["chapters"][0]["verses"][0]["text"], "Words continue.")

    def test_usx_milestones_and_inline_text(self):
        xml = b'<usx version="3.0"><book code="JHN" style="id">John</book><chapter number="1" sid="JHN 1"/><para style="p"><verse number="1" sid="JHN 1:1"/>Words <char style="it">here</char>.<verse eid="JHN 1:1"/></para><chapter eid="JHN 1"/></usx>'
        result = c.parse_usx(xml, c.Report())
        self.assertEqual(result["books"][0]["chapters"][0]["verses"][0]["text"], "Words here.")
        with self.assertRaises(c.ConversionError):
            c.parse_usx(xml.replace(b'eid="JHN 1:1"', b'eid="JHN 1:2"'), c.Report())
        with self.assertRaises(c.ConversionError):
            c.parse_usx(xml.replace(b'number="1" sid="JHN 1:1"', b'number="2" sid="JHN 1:1"'), c.Report())

    def test_usx_does_not_interpret_literal_backslashes_as_usfm(self):
        xml = b'<usx><book code="JHN"/><chapter number="1"/><para style="p"><verse number="1"/>A literal \\word remains.</para></usx>'
        self.assertEqual(c.parse_usx(xml, c.Report())["books"][0]["chapters"][0]["verses"][0]["text"], "A literal \\word remains.")

    def test_docx_reads_paragraph_runs_tabs_and_unicode(self):
        data = docx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>John 1:1</w:t><w:tab/><w:t>שלום</w:t></w:r></w:p><w:p><w:r><w:t>John 1:2 Second</w:t></w:r></w:p></w:body></w:document>')
        text = c.docx_text(data, c.Report())
        result = c.referenced_lines(text, c.Report())
        self.assertEqual(result["books"][0]["chapters"][0]["verses"][0]["text"], "שלום")

    def test_docx_rejects_tracked_changes_and_does_not_extract_archives(self):
        for element in ["ins", "del", "fldChar", "drawing", "altChunk"]:
            xml = f'<w:document xmlns:w="urn:test"><w:p><w:{element}/><w:t>John 1:1 Text</w:t></w:p></w:document>'
            with self.subTest(element=element), self.assertRaises(c.ConversionError):
                c.docx_text(docx(xml), c.Report())
        with self.assertRaises(c.ConversionError):
            c.docx_text(b'not a zip', c.Report())

    def test_cli_deterministic_output_validates_and_loads_in_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, a, b = root / "input.txt", root / "a.json", root / "b.json"
            source.write_text("John 1:1 Unicode שלום\nJohn 1:3 Third\n", encoding="utf-8")
            prefix = ["node", str(ROOT / "bin/lamplighter-formats.js"), "convert", str(source), "--from", "vpl", "--name", "Example"]
            for output in [a, b]:
                run = subprocess.run(prefix + ["--out", str(output)], text=True, capture_output=True)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(json.loads(run.stdout)["validation"], "passed")
            self.assertEqual(a.read_bytes(), b.read_bytes())
            script = "const fs=require('fs');const B=require(process.argv[1]);const m=new B(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));if(m.chapters[0][0][2]!=='Third'||m.chapters[0][0][1]!=='')process.exit(1)"
            subprocess.run(["node", "-e", script, str(ROOT / "vendor/bible-model.js"), str(a)], check=True)
            second = subprocess.run(prefix + ["--out", str(a)], text=True, capture_output=True)
            self.assertNotEqual(second.returncode, 0)
            protected = subprocess.run(prefix + ["--out", str(source), "--force"], text=True, capture_output=True)
            self.assertNotEqual(protected.returncode, 0)
            protected_report = subprocess.run(prefix + ["--out", str(root / "c.json"), "--report", str(source), "--force"], text=True, capture_output=True)
            self.assertNotEqual(protected_report.returncode, 0)

    def test_cli_docx_binary_is_not_decoded_as_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.docx"
            source.write_bytes(docx('<document><p><t>John 1:1 A Word verse.</t></p></document>'))
            run = subprocess.run([sys.executable, str(ROOT / "scripts/convert.py"), str(source), "--from", "docx", "--name", "Example", "--out", str(Path(directory) / "output.json")], text=True, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr)

    def test_external_extractor_failure_and_output_limit(self):
        with self.assertRaises(c.ConversionError):
            c.run_bounded([sys.executable, "-c", "raise SystemExit(4)"])
        self.assertEqual(c.run_bounded([sys.executable, "-c", "print('hello')"]), b"hello\n")

    def test_word_positions_match_the_javascript_tokenizer(self):
        fixture = json.loads((ROOT / "tests/fixtures/tokenizer.json").read_text())
        for case in fixture["cases"]:
            self.assertEqual([case["text"][a:b] for a, b in c.word_spans(case["text"])], case["words"], case["text"])

    def test_usfm_strongs_tags_become_word_links_for_an_edition(self):
        source = ('\\id GEN\n\\c 1\n\\d \\w A|strong="H9000"\\w* song.\n'
                  '\\v 1 At the \\w start|strong="H9001"\\w* the \\w maker|strong="H09003"\\w* \\w made|strong="H9002a"\\w* '
                  '\\add all\\add* the \\w lamps|strong="H9004,H9005"\\w*.\n')
        report = c.Report(allow_lossy=True)
        parsed = c.parse_usfm(source, report, tags=True)
        # The same source without tags converts to plain text as before
        plain = c.parse_usfm(source, c.Report(allow_lossy=True))
        self.assertEqual(plain["books"][0]["chapters"][0]["verses"][0]["text"], "At the start the maker made all the lamps.")
        target = {"books": [{"name": "Genesis", "chapters": [{"verses": [{"verse": 1, "text": "At the start the Maker made all the lamps."}]}]}]}
        links = c.build_links(parsed, target, report)
        self.assertEqual(links["verses"]["0.1.1"], [[2, "H9001"], [4, "H9003"], [5, "H9002"], [6, ""], [8, "H9004 H9005"]])

    def test_osis_lemmas_and_added_words_become_word_links(self):
        osis = (b'<osis xmlns="http://www.bibletechnologies.net/2003/OSIS/namespace"><osisText><div type="book" osisID="Gen">'
                b'<verse osisID="Gen.1.1"><w lemma="strong:H9001">At the start</w> <transChange type="added">all</transChange> '
                b'<w lemma="lemma.X:abc strong:H9002">lamps</w> shone</verse></div></osisText></osis>')
        report = c.Report(allow_lossy=True)
        parsed = c.parse_osis(osis, report, tags=True)
        target = {"books": [{"name": "Genesis", "chapters": [{"verses": [{"verse": 1, "text": "At the start all lamps shone, then"}]}]}]}
        self.assertEqual(c.build_links(parsed, target, report)["verses"]["0.1.1"], [[0, "H9001"], [1, "H9001"], [2, "H9001"], [3, ""], [4, "H9002"]])
        # A book's key is its place in the target edition
        partial = {"books": [{"name": "Exodus", "chapters": [{"verses": [{"verse": 1, "text": "x"}]}]}, target["books"][0]]}
        self.assertEqual(list(c.build_links(parsed, partial, report)["verses"]), ["1.1.1"])
        other = {"books": [{"name": "Genesis", "chapters": [{"verses": [{"verse": 1, "text": "Nothing alike here"}]}]}]}
        with self.assertRaises(c.ConversionError):
            c.build_links(parsed, other, report)

    def test_cli_word_links_validate(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, edition, out = Path(tmp, "gen.usfm"), Path(tmp, "edition.json"), Path(tmp, "links.json")
            src.write_text('\\id GEN\n\\c 1\n\\v 1 The \\w lamp|strong="H9004"\\w* \\w shone|strong="H9006"\\w*.\n')
            edition.write_text(json.dumps({"abbreviation": "SMP", "books": [{"name": "Genesis", "chapters": [{"verses": [{"verse": 1, "text": "The lamp shone."}]}]}]}))
            self.assertEqual(c.main([str(src), "--from", "usfm", "--links-for", str(edition), "--out", str(out), "--license", "CC0"]), 0)
            data = json.loads(out.read_text())
            self.assertEqual((data["type"], data["edition"], data["tokenizer"]), ("word-links", "SMP", "lamplighter-words-1"))
            self.assertEqual(data["editionSha256"], hashlib.sha256(edition.read_bytes()).hexdigest())
            self.assertEqual(data["verses"], {"0.1.1": [[1, "H9004"], [2, "H9006"]]})
            self.assertEqual(c.main([str(src), "--from", "text", "--links-for", str(edition), "--out", str(Path(tmp, "x.json"))]), 1)

    def test_sword_refuses_locked_and_ambiguous_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'mods.d').mkdir()
            config = root / 'mods.d/sample.conf'
            config.write_text('[Sample]\nModDrv=RawText\nCipherKey=\n')
            with self.assertRaisesRegex(c.ConversionError, 'locked'):
                c.sword_configuration('Sample', str(root))
            config.write_text('[Sample]\nModDrv=RawText\n')
            self.assertEqual(c.sword_configuration('Sample', str(root)), root)
            (root / 'mods.d/duplicate.conf').write_text(config.read_text())
            with self.assertRaisesRegex(c.ConversionError, 'exactly one'):
                c.sword_configuration('Sample', str(root))


if __name__ == "__main__":
    unittest.main()
