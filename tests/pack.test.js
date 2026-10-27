'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { detectKind, lint } = require('../lib/validate');
const pack = require('../lib/pack');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const cli = (...a) => { try { return { code: 0, out: execFileSync('node', [path.join(__dirname, '..', 'bin', 'lamplighter-formats.js'), ...a], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
const at = (chapter, verse) => ({ book: 'Genesis', book_index: 0, ...(chapter && { chapter }), ...(verse && { verse }) });
const note = (start, end, content) => ({ range: { start, end: end ?? start }, content });
const files = manifest => manifest.parts.map(part => part.file);

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
  const { manifest, parts } = pack.split(commentary);
  const folder = path.join(TEMPLATES, 'commentary-pack.sample');
  assert.equal(fs.readFileSync(path.join(folder, 'pack.json'), 'utf8'), JSON.stringify(manifest, null, 1) + '\n');
  for (const part of parts) assert.equal(fs.readFileSync(path.join(folder, part.file), 'utf8'), part.text);
  const report = pack.verify(folder, { keep: true });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(pack.join(report.manifest, report.parts), { ...commentary, formatVersion: 1 });
});

test('a large book splits into a book part and even chapter runs, splitting an oversized chapter between verses', () => {
  const commentary = sample();
  const { manifest, parts } = pack.split(commentary, { maxPartBytes: 4096 });
  assert.equal(manifest.type, 'commentary-pack');
  assert.equal(manifest.entryCount, commentary.entries.length);
  assert.equal(files(manifest)[0], '000-gen-book.json');
  assert.ok(files(manifest).some(f => /^000-gen-011\.\d+/.test(f)), files(manifest).join(' '));
  assert.equal(files(manifest).at(-1), '042-jhn.json');
  for (const part of manifest.parts.slice(0, -1)) assert.ok(part.bytes <= 4096, `${part.file} is ${part.bytes} bytes`);
  const chapterRuns = manifest.parts.filter(part => /^000-gen-\d{3}(-\d{3})?\.json$/.test(part.file)).map(part => part.bytes);
  assert.ok(Math.min(...chapterRuns) > Math.max(...chapterRuns) / 2, `uneven runs ${chapterRuns}`);
  const entries = parts.flatMap(part => JSON.parse(part.text).entries);
  const firstOn21 = entries.findIndex(e => e.content.startsWith('On 2:1.'));
  assert.equal(entries[firstOn21 + 1].content, 'A second note on 2:1, after the first.');
  const joined = pack.join(manifest, parts.map(part => JSON.parse(part.text)));
  assert.equal(joined.entries.length, commentary.entries.length);
  assert.deepEqual(new Set(joined.entries.map(e => e.content)), new Set(commentary.entries.map(e => e.content)));
  assert.deepEqual(lint(joined).errors, []);
});

test('a reader needs only the parts whose range overlaps the passage', () => {
  const { manifest, parts } = pack.split(sample(), { maxPartBytes: 4096 });
  const forVerse = (c, v) => files({ parts: pack.partsFor(manifest, at(c, v)) });
  const holding = text => manifest.parts[parts.findIndex(part => part.text.includes(text))].file;
  assert.deepEqual(forVerse(1, 1), ['000-gen-book.json', holding('On 1:1.')]);
  assert.deepEqual(files({ parts: pack.partsFor(manifest, { book_index: 42, chapter: 1, verse: 1 }) }), ['042-jhn.json']);
  // The note on 3:5-9:1 widens its part's range, so 8:1 loads that part as well as its own.
  assert.notEqual(holding('Across several chapters.'), holding('On 8:1.'));
  assert.deepEqual(forVerse(8, 1), ['000-gen-book.json', holding('Across several chapters.'), holding('On 8:1.')]);
  assert.ok(!forVerse(10, 1).includes(holding('Across several chapters.')));
  assert.equal(pack.partsFor(manifest, at(1, 1), at(11, 6)).length, manifest.parts.length - 1);
});

test('verify finds a changed, missing or misplaced part and notes stray files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplighter-pack-'));
  try {
    const folder = path.join(dir, 'pack');
    const manifest = pack.write(folder, sample(), { maxPartBytes: 4096 });
    assert.deepEqual(pack.verify(folder).errors, []);
    assert.throws(() => pack.write(folder, sample()), /not empty/);

    fs.writeFileSync(path.join(folder, 'notes.json'), '{}');
    assert.ok(pack.verify(folder).warnings.some(w => /notes\.json is in the folder but not listed/.test(w)));

    const first = path.join(folder, manifest.parts[1].file);
    const original = fs.readFileSync(first);
    fs.writeFileSync(first, original.toString().replace('On 1:1.', 'On 1:9.'));
    assert.ok(pack.verify(folder).errors.some(e => /sha256 does not match/.test(e)));
    fs.rmSync(first);
    assert.ok(pack.verify(folder).errors.some(e => /not in the folder/.test(e)));
    fs.writeFileSync(first, original);

    // A manifest whose part range does not cover the part's entries
    const narrowed = structuredClone(manifest);
    narrowed.parts[1].range.end = { book_index: 0, chapter: 1, verse: 1 };
    fs.writeFileSync(path.join(folder, 'pack.json'), JSON.stringify(narrowed));
    assert.ok(pack.verify(folder).errors.some(e => /lies outside the part's range/.test(e)));

    const miscounted = structuredClone(manifest);
    miscounted.entryCount += 1;
    fs.writeFileSync(path.join(folder, 'pack.json'), JSON.stringify(miscounted));
    assert.ok(pack.verify(folder).errors.some(e => /"entryCount" is \d+; the parts hold/.test(e)));

    const escaping = structuredClone(manifest);
    escaping.parts[0].file = '../outside.json';
    fs.writeFileSync(path.join(folder, 'pack.json'), JSON.stringify(escaping));
    assert.ok(pack.verify(folder).errors.some(e => /plain file name/.test(e)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('released readers pass over packs: neither file is a commentary with entries', () => {
  const folder = path.join(TEMPLATES, 'commentary-pack.sample');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'pack.json'), 'utf8'));
  const part = JSON.parse(fs.readFileSync(path.join(folder, manifest.parts[0].file), 'utf8'));
  for (const data of [manifest, part]) assert.ok(!(data.type === 'commentary' && data.entries));
  assert.equal(detectKind(manifest), 'commentary-pack');
  assert.equal(detectKind(part), 'commentary-part');
  assert.ok(lint({ ...manifest, formatVersion: undefined }).errors.some(e => /formatVersion/.test(e)));
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
    assert.equal(cli('pack', source, '--out', out).code, 1);
    assert.equal(cli('pack', source, '--out', path.join(dir, 'x'), '--max-part-bytes', 'big').code, 2);
    assert.equal(cli('pack', path.join(TEMPLATES, 'edition.sample.json'), '--out', path.join(dir, 'ed')).code, 1);

    const linted = cli('lint', out);
    assert.equal(linted.code, 0, linted.out);
    assert.match(linted.out, /commentary-pack · 0 errors · 0 warnings/);
    assert.equal(cli('lint', path.join(out, 'pack.json')).code, 0);
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
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, '042-jhn.json'))).digest('hex'), JSON.parse(fs.readFileSync(path.join(out, 'pack.json'))).parts.at(-1).sha256);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
