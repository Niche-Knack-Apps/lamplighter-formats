'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { detectKind, lint } = require('../lib/validate');
const pack = require('../lib/pack');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const cli = (...a) => { try { return { code: 0, out: execFileSync('node', [path.join(__dirname, '..', 'bin', 'lamplighter-formats.js'), ...a], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
const at = (chapter, verse) => ({ book: 'Genesis', book_index: 0, ...(chapter && { chapter }), ...(verse && { verse }) });
const note = (start, end, content) => ({ range: { start, end: end ?? start }, content });
const files = list => list.map(part => part.file);

// Genesis 1-10 with five notes a chapter, a book note, a note from 3:5 to 9:1,
// two notes on 2:1 whose order matters, and a chapter 11 too large for one part.
function sample() {
  const entries = [note(at(), null, 'On the whole book.')];
  for (let c = 1; c <= 10; c++) for (let v = 1; v <= 5; v++) entries.push(note(at(c, v), null, `On ${c}:${v}. ${'word '.repeat(40)}`));
  entries.push(note(at(3, 5), at(9, 1), 'Across several chapters.'));
  entries.push(note(at(2, 1), null, 'A second note on 2:1, after the first.'));
  for (let v = 1; v <= 6; v++) entries.push(note(at(11, v), null, `On 11:${v}. ${'long '.repeat(120)}`));
  entries.push(note({ book: 'John', book_index: 42, chapter: 1, verse: 1 }, null, 'In the beginning was the Word.'));
  return { name: 'Split Test', type: 'commentary', license: 'Public Domain', entries };
}

test('the sample pack is what pack makes of the sample commentary, and unpacks to it', () => {
  const commentary = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'commentary.sample.json'), 'utf8'));
  const { metadata, index, parts } = pack.split(commentary);
  const folder = path.join(TEMPLATES, 'commentary-pack.sample');
  assert.equal(fs.readFileSync(path.join(folder, '_metadata.json'), 'utf8'), pack.metadataText(metadata));
  assert.equal(fs.readFileSync(path.join(folder, '_index.json'), 'utf8'), pack.indexText(index));
  assert.deepEqual(JSON.parse(pack.indexText(index)), index);
  for (const part of parts) assert.equal(fs.readFileSync(path.join(folder, part.file), 'utf8'), part.text);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['000-gen.json', '042-jhn.json', '_index.json', '_metadata.json']);
  const report = pack.verify(folder, { keep: true });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(pack.join(report.metadata, report.parts), { ...commentary, formatVersion: 1 });
});

test('a large book splits into a book part and even chapter runs, splitting an oversized chapter between verses', () => {
  const commentary = sample();
  const { metadata, index, parts } = pack.split(commentary, { maxPartBytes: 4096 });
  assert.equal(metadata.type, 'commentary-pack');
  assert.equal(metadata.entryCount, commentary.entries.length);
  assert.equal(index.type, 'commentary-index');
  assert.equal(files(index.parts)[0], '000-gen-book.json');
  assert.ok(files(index.parts).some(f => /^000-gen-011\.\d+/.test(f)), files(index.parts).join(' '));
  assert.equal(files(index.parts).at(-1), '042-jhn.json');
  for (const part of index.parts.slice(0, -1)) assert.ok(part.bytes <= 4096, `${part.file} is ${part.bytes} bytes`);
  const chapterRuns = index.parts.filter(part => /^000-gen-\d{3}(-\d{3})?\.json$/.test(part.file)).map(part => part.bytes);
  assert.ok(Math.min(...chapterRuns) > Math.max(...chapterRuns) / 2, `uneven runs ${chapterRuns}`);
  const entries = parts.flatMap(part => JSON.parse(part.text).entries);
  const firstOn21 = entries.findIndex(e => e.content.startsWith('On 2:1.'));
  assert.equal(entries[firstOn21 + 1].content, 'A second note on 2:1, after the first.');
  const joined = pack.join(metadata, parts.map(part => JSON.parse(part.text)));
  assert.equal(joined.entries.length, commentary.entries.length);
  assert.deepEqual(new Set(joined.entries.map(e => e.content)), new Set(commentary.entries.map(e => e.content)));
  assert.deepEqual(lint(joined).errors, []);
  assert.deepEqual(lint(index).errors, []);
  assert.deepEqual(lint(metadata).errors, []);
});

test('the index finds exactly the parts a passage needs', () => {
  const { index, parts } = pack.split(sample(), { maxPartBytes: 4096 });
  const holding = text => index.parts[parts.findIndex(part => part.text.includes(text))].file;
  const forVerses = (c, ...v) => files(pack.partsFor(index, 0, c, v));
  assert.deepEqual(forVerses(1, 1), [holding('On 1:1.')]);
  assert.deepEqual(files(pack.wholeBookParts(index, 0)), ['000-gen-book.json']);
  assert.deepEqual(index.books['0'].names, ['Genesis']);
  // The note on 3:5-9:1 stays in chapter 3's part; the index sends 4:1 through 9:1 to it, and no further.
  assert.notEqual(holding('Across several chapters.'), holding('On 8:1.'));
  assert.deepEqual(forVerses(8, 1), [holding('Across several chapters.'), holding('On 8:1.')].sort());
  assert.ok(forVerses(9, 1).includes(holding('Across several chapters.')));
  assert.ok(!forVerses(9, 2).includes(holding('Across several chapters.')));
  assert.deepEqual(forVerses(9, 2), [holding('On 9:2.')]);
  // Chapter 11 is split between verses: each verse needs only its own part.
  assert.deepEqual(forVerses(11, 6), [holding('On 11:6.')]);
  assert.notEqual(holding('On 11:1.'), holding('On 11:6.'));
  assert.ok(files(pack.partsFor(index, 0, 11)).length > 1, 'a whole chapter needs all of its parts');
  assert.deepEqual(forVerses(10, 9), [], 'no notes on 10:9');
  assert.deepEqual(files(pack.partsFor(index, 42, 1, [1])), ['042-jhn.json']);
  assert.deepEqual(pack.partsFor(index, 42, 2, [1]), []);
  assert.deepEqual(pack.partsFor(index, 5, 1, [1]), []);
});

test('the lookup runs in a browser as window.CommentaryPack, with the same answers', () => {
  const { index } = pack.split(sample(), { maxPartBytes: 4096 });
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pack-reader.js'), 'utf8'), { window });
  assert.equal(window.CommentaryPack.METADATA, '_metadata.json');
  assert.equal(window.CommentaryPack.INDEX, '_index.json');
  // Values made inside the browser context have its own prototypes; compare them as JSON.
  const same = (x, y) => assert.equal(JSON.stringify(x), JSON.stringify(y));
  for (const [c, v] of [[1, 1], [8, 1], [9, 2], [11, 6]]) same(window.CommentaryPack.partsFor(index, 0, c, [v]), pack.partsFor(index, 0, c, [v]));
  same(window.CommentaryPack.wholeBookParts(index, 0), pack.wholeBookParts(index, 0));
  same(window.CommentaryPack.bookNames(index), { 0: ['Genesis'], 42: ['John'] });
});

test('verify finds a changed, missing or unlisted part and an index that does not match the notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplighter-pack-'));
  try {
    const folder = path.join(dir, 'pack');
    const { metadata, index } = pack.write(folder, sample(), { maxPartBytes: 4096 });
    assert.deepEqual(pack.verify(folder).errors, []);
    assert.throws(() => pack.write(folder, sample()), /not empty/);

    fs.writeFileSync(path.join(folder, 'notes.json'), '{}');
    assert.ok(pack.verify(folder).warnings.some(w => /notes\.json is in the folder but not listed/.test(w)));

    const first = path.join(folder, index.parts[1].file);
    const original = fs.readFileSync(first);
    fs.writeFileSync(first, original.toString().replace('On 1:1.', 'On 1:9.'));
    assert.ok(pack.verify(folder).errors.some(e => /sha256 does not match/.test(e)));
    fs.rmSync(first);
    assert.ok(pack.verify(folder).errors.some(e => /not in the folder/.test(e)));
    fs.writeFileSync(first, original);

    const writeIndex = changed => fs.writeFileSync(path.join(folder, '_index.json'), JSON.stringify(changed));
    const missing = structuredClone(index);
    missing.books['0'].chapters['9'] = missing.books['0'].chapters['9'].slice(1); // the long note's part
    writeIndex(missing);
    assert.ok(pack.verify(folder).errors.some(e => /Genesis 9 .* the parts need/.test(e)), 'a note the index cannot find');
    const extra = structuredClone(index);
    extra.books['0'].chapters['10'].push(0);
    writeIndex(extra);
    assert.ok(pack.verify(folder).errors.some(e => /Genesis 10 /.test(e)), 'a part the index sends readers to for nothing');
    const unreached = structuredClone(index);
    delete unreached.books['42'];
    writeIndex(unreached);
    assert.ok(pack.verify(folder).errors.some(e => /no book or chapter in "books" points to 042-jhn\.json/.test(e)));
    const escaping = structuredClone(index);
    escaping.parts[0].file = '../outside.json';
    writeIndex(escaping);
    assert.ok(pack.verify(folder).errors.some(e => /plain file name/.test(e)));
    writeIndex(index);

    fs.writeFileSync(path.join(folder, '_metadata.json'), JSON.stringify({ ...metadata, entryCount: metadata.entryCount + 1 }));
    assert.ok(pack.verify(folder).errors.some(e => /"entryCount" is \d+; the parts in _index\.json hold/.test(e)));
    fs.rmSync(path.join(folder, '_metadata.json'));
    assert.ok(pack.verify(folder).errors.some(e => /holds no _metadata\.json/.test(e)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('released readers pass over packs: none of the files is a commentary with entries', () => {
  const folder = path.join(TEMPLATES, 'commentary-pack.sample');
  const read = name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
  const metadata = read('_metadata.json'), index = read('_index.json');
  const part = read(index.parts[0].file);
  for (const data of [metadata, index, part]) assert.ok(!(data.type === 'commentary' && data.entries));
  assert.equal(detectKind(metadata), 'commentary-pack');
  assert.equal(detectKind(index), 'commentary-index');
  assert.equal(detectKind(part), 'commentary-part');
  assert.ok(lint({ ...metadata, formatVersion: undefined }).errors.some(e => /formatVersion/.test(e)));
  assert.ok(lint({ ...metadata, entries: [] }).errors.some(e => /does not belong in the metadata/.test(e)));
});

test('the command line packs, checks, describes and unpacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplighter-pack-cli-'));
  try {
    const source = path.join(dir, 'notes.json');
    fs.writeFileSync(source, JSON.stringify(sample()));
    const out = path.join(dir, 'notes');
    const made = cli('pack', source, '--out', out, '--max-part-bytes', '4K');
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /\d+ parts, 60 entries/);
    assert.ok(fs.existsSync(path.join(out, '_metadata.json')) && fs.existsSync(path.join(out, '_index.json')));
    assert.equal(cli('pack', source, '--out', out).code, 1);
    assert.equal(cli('pack', source, '--out', path.join(dir, 'x'), '--max-part-bytes', 'big').code, 2);
    assert.equal(cli('pack', path.join(TEMPLATES, 'edition.sample.json'), '--out', path.join(dir, 'ed')).code, 1);

    const linted = cli('lint', out);
    assert.equal(linted.code, 0, linted.out);
    assert.match(linted.out, /commentary-pack · 0 errors · 0 warnings/);
    for (const name of ['_metadata.json', '_index.json']) assert.match(cli('lint', path.join(out, name)).out, /commentary-pack · 0 errors · 0 warnings/);
    const part = cli('lint', path.join(out, '042-jhn.json'));
    assert.match(part.out, /commentary-part · 0 errors · 1 warning/);
    const info = JSON.parse(cli('info', out).out);
    assert.equal(info.kind, 'commentary-pack');
    assert.equal(info.entries, 60);

    const back = path.join(dir, 'back.json');
    assert.equal(cli('unpack', out, '--out', back).code, 0);
    assert.equal(cli('unpack', out, '--out', back).code, 1, 'never replaces an existing file');
    const joined = JSON.parse(fs.readFileSync(back, 'utf8'));
    assert.equal(joined.type, 'commentary');
    assert.equal(joined.entries.length, 60);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, '042-jhn.json'))).digest('hex'), JSON.parse(fs.readFileSync(path.join(out, '_index.json'))).parts.at(-1).sha256);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
