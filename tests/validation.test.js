'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('../lib/validate');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('malformed nested values report errors without crashing', () => {
  for (const value of [{ books: [null] }, { books: [{ name: 'John', chapters: [null] }] }, { books: [{ name: 'John', chapters: [{ verses: [[]] }] }] }, { meta: {}, refs: [] }, { meta: {}, verses: [] }]) {
    assert.ok(lint(value).errors.length, JSON.stringify(value));
  }
  assert.ok(lint(null, { kind: 'edition' }).errors.length);
  assert.ok(lint({ books: 'bad' }, { kind: 'edition' }).errors.length);
});

test('study resource references reject zero chapter/verse and reversed ranges', () => {
  assert.ok(lint({ meta: {}, refs: { '0.0.1': [] } }).errors.length);
  assert.ok(lint({ meta: {}, refs: { '0.1.1': [{ ref: '0.1.3', endRef: '0.1.2' }] } }).errors.length);
  assert.ok(lint({ name: 'Notes', type: 'commentary', entries: [{ range: { start: { book_index: 0, chapter: 1, verse: 3 }, end: { book_index: 0, chapter: 1, verse: 2 } }, content: 'A note.' }] }).errors.length);
  assert.ok(lint({ name: 'Notes', type: 'commentary', entries: [{ range: { start: { book_index: 0 }, end: { book_index: -1 } }, content: 'A note.' }] }).errors.length);
});

test('new version metadata is optional but unknown versions fail clearly', () => {
  const data = require('../templates/edition.sample.json');
  assert.deepEqual(lint(data).errors, []);
  assert.ok(lint({ ...data, formatVersion: 2 }).errors.some(x => x.includes('formatVersion')));
  assert.ok(lint({ ...data, source: { sha256: 'wrong' } }).errors.length);
  assert.deepEqual(lint({ ...data, formatVersion: 1, source: { format: 'osis', sha256: 'a'.repeat(64) } }).errors, []);
});

test('original-language and lexicon templates lint clean', () => {
  for (const name of ['original-language', 'lexicon']) assert.deepEqual(lint(require(`../templates/${name}.sample.json`)).errors, []);
});

test('UTF-8 validation accepts an intentional replacement character', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplighter-utf8-'));
  try {
    const file = path.join(dir, 'edition.json');
    const data = { name: 'Example', books: [{ name: 'John', chapters: [{ verses: [{ text: '\ufffd' }] }] }] };
    fs.writeFileSync(file, JSON.stringify(data));
    execFileSync('node', [path.join(__dirname, '..', 'bin/lamplighter-formats.js'), 'lint', file], { stdio: 'pipe' });
  } finally { fs.rmSync(dir, { recursive: true }); }
});
