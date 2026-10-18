'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lint, detectKind } = require('../lib/validate');
const { newEdition } = require('../lib/skeleton');
const BibleModel = require('../vendor/bible-model');
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', f), 'utf8'));
const cli = (...a) => { try { return { code: 0, out: execFileSync('node', [path.join(__dirname, '..', 'bin', 'lamplighter-formats.js'), ...a], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };

test('the sample templates lint clean and are told apart by shape', () => {
  for (const [file, kind] of [['edition.sample.json', 'edition'], ['commentary.sample.json', 'commentary'], ['cross-references.sample.json', 'cross-references']]) {
    const data = read(file);
    assert.equal(detectKind(data), kind);
    const report = lint(data);
    assert.deepEqual(report.errors, [], file);
  }
  const edition = lint(read('edition.sample.json'));
  assert.equal(edition.info.books, 2);
  assert.ok(edition.warnings.some(w => /Genesis has 2 chapters here; the usual count is 50/.test(w)), 'canon note is a warning, not an error');
});

test('an edition with the wrong shape is refused in plain words', () => {
  const data = read('edition.sample.json');
  data.books[0].chapters[0].verses[2].verse = 7;
  data.books[0].chapters[1].chapter = 5;
  data.books[1].chapters[0].verses[0].text = 42;
  data.books.push({ name: 'Genesis', chapters: [{ chapter: 1, verses: [] }] });
  const report = lint(data);
  assert.ok(report.errors.some(e => /"verse" 7 sits at position 3/.test(e)));
  assert.ok(report.errors.some(e => /"chapter" is 5/.test(e)));
  assert.ok(report.errors.some(e => /"text" must be a string/.test(e)));
  assert.ok(report.errors.some(e => /appears twice/.test(e)));
  assert.equal(lint({ hello: 'world' }).errors.length, 1);
  assert.ok(lint({ books: [] }).errors.some(e => /empty/.test(e)));
});

test('right-to-left text is noticed', () => {
  const data = { name: 'Hebrew sample', abbreviation: 'HEB', license: 'Public Domain', books: [{ name: 'Genesis', chapters: [{ chapter: 1, verses: [{ verse: 1, text: 'בְּרֵאשִׁית בָּרָא אֱלֹהִים' }] }] }] };
  assert.ok(lint(data).warnings.some(w => /right to left/.test(w)));
  data.textDirection = 'rtl';
  assert.ok(!lint(data).warnings.some(w => /right to left/.test(w)));
});

test('a new edition holds the whole canon with empty texts, and the app\'s own model reads it', () => {
  const edition = newEdition({ name: 'New Language Bible', abbreviation: 'NLB', language: 'xyz', license: 'CC BY 4.0' });
  assert.equal(edition.books.length, 66);
  assert.equal(edition.books[0].chapters.length, 50);
  assert.equal(edition.books[0].chapters[0].verses.length, 31);
  assert.equal(edition.books[18].chapters[118].verses.length, 176);
  assert.equal(newEdition({ name: 'NT', books: 'nt' }).books.length, 27);
  assert.deepEqual(newEdition({ name: 'Two', books: ['Genesis', 'Jhn'] }).books.map(b => b.name), ['Genesis', 'John']);
  assert.throws(() => newEdition({ name: 'X', books: ['Nowhere'] }), /not a book/);
  const report = lint(edition);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some(w => /31102 verses with empty text/.test(w)));
  edition.books[0].chapters[0].verses[0].text = 'In the beginning…';
  const model = new BibleModel(edition);
  assert.equal(model.books.length, 66);
  assert.equal(model.maxChapter(0), 50);
  assert.equal(model.chapters[0][0][0], 'In the beginning…');
  assert.equal(model.findBook('John'), 42);
});

test('the command line lints, starts and describes files', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp-'));
  try {
    const made = cli('new', 'Trial Edition', '--out', path.join(dir, 'trial.json'), '--abbreviation', 'TRL', '--license', 'Public Domain', '--books', 'nt');
    assert.equal(made.code, 0);
    assert.match(made.out, /27 books, 260 chapters, 7957 verses/);
    const clean = cli('lint', path.join(__dirname, '..', 'templates', 'edition.sample.json'));
    assert.equal(clean.code, 0);
    assert.match(clean.out, /edition · 0 errors/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"books":[{"name":"Genesis","chapters":[{"chapter":2,"verses":[]}]}]}');
    const bad = cli('lint', path.join(dir, 'bad.json'), '--json');
    assert.equal(bad.code, 1);
    assert.ok(JSON.parse(bad.out)[0].errors.some(e => /"chapter" is 2/.test(e)));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"books": [');
    assert.equal(cli('lint', path.join(dir, 'broken.json')).code, 1);
    const info = cli('info', path.join(dir, 'trial.json'));
    assert.equal(info.code, 0);
    assert.equal(JSON.parse(info.out).books, 27);
    assert.equal(cli('nonsense').code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
