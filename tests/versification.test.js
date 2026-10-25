'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Versification = require('../lib/versification');
const data = require('../lib/versification-data');
const { lint } = require('../lib/validate');

const refs = list => list.map(r => `${r.b} ${r.c}:${r.v}`);
const map = (text, from, to) => {
  const [b, cv] = text.split(' ');
  const [c, v] = cv.split(':').map(Number);
  return refs(Versification.map({ b, c, v }, from, to));
};

test('known verse equivalences map both ways', () => {
  assert.deepEqual(map('MAL 4:1', 'eng', 'org'), ['MAL 3:19']);
  assert.deepEqual(map('MAL 3:19', 'org', 'eng'), ['MAL 4:1']);
  assert.deepEqual(map('JOL 2:28', 'eng', 'org'), ['JOL 3:1']);
  assert.deepEqual(map('GEN 32:1', 'eng', 'org'), ['GEN 32:2']);
  // Psalm titles are verse 1 in Hebrew numbering and verse 0 (no verse) in English
  assert.deepEqual(map('PSA 3:1', 'eng', 'org'), ['PSA 3:2']);
  assert.deepEqual(map('PSA 3:1', 'org', 'eng'), ['PSA 3:0']);
  // The Vulgate joins Psalms 9 and 10, so its later psalm numbers run one behind
  assert.deepEqual(map('PSA 10:2', 'vul', 'eng'), ['PSA 11:1']);
  assert.deepEqual(map('PSA 9:22', 'vul', 'org'), ['PSA 10:0', 'PSA 10:1']);
  assert.deepEqual(map('MAL 3:19', 'org', 'vul'), ['MAL 4:1']);
});

test('unlisted verses and unknown schemes keep their numbers', () => {
  assert.deepEqual(map('JHN 3:16', 'eng', 'org'), ['JHN 3:16']);
  assert.deepEqual(map('MAL 4:1', 'eng', 'eng'), ['MAL 4:1']);
  assert.deepEqual(map('MAL 4:1', 'eng', null), ['MAL 4:1']);
  assert.deepEqual(map('MAL 4:1', 'lxx', 'org'), ['MAL 4:1']);
});

test('every one-to-one English mapping returns to where it started', () => {
  let checked = 0;
  for (const line of data.schemes.eng.toOriginal) {
    const [b, c, first, last] = /^(\w{3}) (\d+):(\d+)(?:-(\d+))?=/.exec(line).slice(1);
    for (let v = +first; v <= +(last || first); v++) {
      const there = Versification.map({ b, c: +c, v }, 'eng', 'org');
      if (there.length !== 1) continue;
      const back = Versification.map(there[0], 'org', 'eng');
      if (back.length !== 1) continue;
      assert.deepEqual(back[0], { b, c: +c, v }, line);
      checked++;
    }
  }
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('an edition is recognized from its own chapter and verse counts', () => {
  for (const scheme of Versification.schemes) {
    // An edition built from one scheme's distinguishing counts
    const books = new Map();
    for (const [book, chapter, counts] of data.fingerprint) {
      if (counts[scheme] === undefined) continue;
      const list = books.get(book) || [];
      if (chapter === 0) list.length = Math.max(list.length, counts[scheme]);
      else list[chapter - 1] = counts[scheme];
      books.set(book, list);
    }
    for (const list of books.values()) for (let i = 0; i < list.length; i++) if (list[i] === undefined) list[i] = 0;
    assert.equal(Versification.detect(id => books.get(id) || null).scheme, scheme);
  }
  assert.deepEqual(Versification.detect(() => null), { scheme: 'eng', evidence: 0, score: { eng: 0, org: 0, vul: 0 } });
  assert.equal(Versification.detect(id => (id === 'MAL' ? [1, 1, 1, 1, 1, 1, 1] : null)).scheme, null);
});

test('declared names map to the schemes the tables cover', () => {
  assert.equal(Versification.normalize('KJV'), 'eng');
  assert.equal(Versification.normalize('NRSVA'), 'eng');
  assert.equal(Versification.normalize('Leningrad'), 'org');
  assert.equal(Versification.normalize('Vulgate'), 'vul');
  assert.equal(Versification.normalize('LXX'), null);
});

test('lint reports the numbering and a declaration that contradicts it', () => {
  const book = (name, osis, counts) => ({ name, osis, chapters: counts.map(n => ({ verses: Array.from({ length: n }, () => ({ text: 'Synthetic verse.' })) })) });
  const malachi = scheme => ({
    name: 'Synthetic', abbreviation: 'SYN', license: 'Synthetic test material', versification: 'KJV',
    books: scheme === 'org'
      ? [book('Joel', 'Joel', [20, 27, 5, 21]), book('Malachi', 'Mal', [14, 17, 24])]
      : [book('Joel', 'Joel', [20, 32, 21]), book('Malachi', 'Mal', [14, 17, 18, 6])]
  });
  assert.equal(lint(malachi('eng')).info.versification, 'eng');
  assert.ok(!lint(malachi('eng')).warnings.some(w => w.includes('"versification"')));
  const hebrew = lint(malachi('org'));
  assert.equal(hebrew.info.versification, 'org');
  assert.ok(hebrew.warnings.some(w => w.includes('"versification" is "KJV"')));
});

test('the generated tables are current', () => {
  execFileSync('python3', ['scripts/build-versification.py', '--check'], { cwd: path.join(__dirname, '..') });
});
