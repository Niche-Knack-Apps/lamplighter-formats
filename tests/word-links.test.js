'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WordLinks = require('../lib/word-links');
const { lint } = require('../lib/validate');
const fixture = require('./fixtures/tokenizer.json');

// An invented verse: original words in their own order, each with the gloss a word-by-word
// translation gives it and where that gloss stands in the translation.
const original = [
  { word: 'אא', strongs: 'H9001', gloss: 'In [the] start', glossOrder: 0 },
  { word: 'בב', strongs: 'H9002', gloss: 'made', glossOrder: 2 },
  { word: 'גג', strongs: 'H9003', gloss: 'the maker', glossOrder: 1 },
  { word: 'דד', strongs: 'H9004', gloss: '', glossOrder: 3 },
  { word: 'הה', strongs: 'H9005', gloss: 'the lamps', glossOrder: 4 }
];
const renderings = new WordLinks.Renderings({ H9002: { made: 5, created: 3 }, H9005: { lamps: 4, lights: 2 } });
const words = text => WordLinks.tokenize(text).map(t => t.text);

test('words are counted the same way everywhere', () => {
  for (const { text, words: expected } of fixture.cases) assert.deepEqual(words(text), expected, text);
  assert.deepEqual(WordLinks.tokenize('the lamp'), [{ text: 'the', start: 0, end: 3 }, { text: 'lamp', start: 4, end: 8 }]);
});

test('English stems join a word with its forms', () => {
  const same = (a, b) => assert.equal(WordLinks.stem(a), WordLinks.stem(b), `${a} / ${b}`);
  same('loved', 'love'); same('loves', 'loving'); same('created', 'createth'); same('beginning', 'begin');
  same('cities', 'city'); same('Lord’s', 'lord');
  assert.notEqual(WordLinks.stem('bless'), WordLinks.stem('bles'));
  assert.equal(WordLinks.stem('Wort', 'de'), 'wort');
});

test('glosses mark the words a translator supplied', () => {
  assert.deepEqual(WordLinks.glossWords('In [the] start'), [{ text: 'In', supplied: false }, { text: 'the', supplied: true }, { text: 'start', supplied: false }]);
  assert.deepEqual(WordLinks.glossWords(''), []);
  assert.deepEqual(WordLinks.glossWords('…'), []);
});

test('a word follows its gloss, its renderings and its place in the verse', () => {
  const text = words('At the start the maker created the lamps');
  assert.deepEqual(WordLinks.project(text, original, renderings), [-1, 0, 0, 2, 2, 1, 4, 4]);
  // Without renderings only words of the glosses link
  assert.deepEqual(WordLinks.project(text, original, null), [-1, 0, 0, 2, 2, -1, 4, 4]);
  // A word no gloss or rendering knows stays unlinked
  assert.deepEqual(WordLinks.project(words('Then lanterns'), original, renderings), [-1, -1]);
});

test('distance decides between two words of the same rendering', () => {
  const twice = [
    { word: 'אא', strongs: 'H9010', gloss: 'the son', glossOrder: 0 },
    { word: 'בב', strongs: 'H9011', gloss: 'of Avi', glossOrder: 1 },
    { word: 'אא', strongs: 'H9010', gloss: 'the son', glossOrder: 2 },
    { word: 'גג', strongs: 'H9012', gloss: 'of Bena', glossOrder: 3 }
  ];
  assert.deepEqual(WordLinks.project(words('the son of Avi, the son of Bena'), twice, null), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('tagged words keep their tags and the rest are projected', () => {
  const text = words('At the start the maker created the lamps');
  const links = WordLinks.linkVerse(text, original, { renderings, tags: [[5, 'H9002'], [0, ''], [7, 'H9005', 4]] });
  assert.deepEqual(links[5], { original: 1, strongs: ['H9002'], tagged: true, supplied: false });
  assert.deepEqual(links[0], { original: -1, strongs: [], tagged: true, supplied: true });
  assert.deepEqual(links[7], { original: 4, strongs: ['H9005'], tagged: true, supplied: false });
  assert.deepEqual(links[4], { original: 2, strongs: ['H9003'], tagged: false, supplied: false });
  // A tagged number missing from the original verse still names the word, without a position
  assert.deepEqual(WordLinks.linkVerse(['lamp'], original, { tags: [[0, 'H9099']] })[0], { original: -1, strongs: ['H9099'], tagged: true, supplied: false });
});

test('renderings ignore inherited object names', () => {
  const r = new WordLinks.Renderings({ H9001: { constructor: 2 } });
  assert.equal(r.count('H9001', 'constructor'), 2);
  assert.equal(r.count('H9001', 'toString'), 0);
  assert.equal(r.ratio('H9999', 'anything'), 0);
});

test('word links, renderings and parsing codes are checked', () => {
  const links = { type: 'word-links', edition: 'X', tokenizer: WordLinks.tokenizer, verses: { '0.1.1': [[0, 'H1'], [1, ''], [2, 'H2 G3', 4]] } };
  assert.deepEqual(lint(links).errors, []);
  assert.match(lint({ ...links, tokenizer: 'other' }).errors[0], /tokenizer/);
  assert.match(lint({ ...links, verses: { '0.1.1': [[0, 'H1'], [0, 'H2']] } }).errors[0], /linked twice/);
  assert.match(lint({ ...links, verses: { '0.1.1': [[0, 'H1,H2']] } }).errors[0], /one string/);
  assert.equal(lint({ type: 'renderings', language: 'en', renderings: { H1: { word: 0 } } }).errors.length, 1);
  assert.equal(lint({ type: 'morph-codes', scheme: 'robinson', codes: { 'N-NSM': '' } }).errors.length, 1);
  assert.equal(lint({ meta: {}, verses: { '0.1.1': [{ word: 'א', glossOrder: -1 }] } }).errors.length, 1);
});

test('the edition the glosses come from links by matching them', () => {
  const text = words('In the start the maker made the lamps');
  assert.deepEqual(WordLinks.glossTags(text, original), [[0, 'H9001', 0], [1, ''], [2, 'H9001', 0], [3, 'H9003', 2], [4, 'H9003', 2], [5, 'H9002', 1], [6, 'H9005', 4], [7, 'H9005', 4]]);
  // A word the printing changed stays untagged and is projected instead
  const changed = WordLinks.linkVerse(words('In the start the maker fashioned the lamps'), original, { renderings, tags: WordLinks.glossTags(words('In the start the maker fashioned the lamps'), original) });
  assert.equal(changed[5], null);
  assert.equal(changed[4].tagged, true);
});

test('original-language words can be compact arrays of named fields', () => {
  const file = { meta: {}, wordFields: ['word', 'strongs', 'gloss', 'glossOrder'], verses: { '0.1.1': [['אא', 'H9001', 'In [the] start', 0], ['בב', 'H9002', null, 1], ['גג']] } };
  assert.deepEqual(WordLinks.originalWords(file, '0.1.1'), [
    { word: 'אא', strongs: 'H9001', gloss: 'In [the] start', glossOrder: 0 }, { word: 'בב', strongs: 'H9002', glossOrder: 1 }, { word: 'גג' }
  ]);
  assert.deepEqual(WordLinks.originalWords({ verses: { '0.1.1': original } }, '0.1.1'), original);
  assert.deepEqual(WordLinks.originalWords(file, '0.1.2'), []);
  assert.deepEqual(lint(file).errors, []);
  assert.equal(lint({ ...file, verses: { '0.1.1': [{ word: 'א' }] } }).errors.length, 1);
  assert.equal(lint({ ...file, wordFields: ['strongs'] }).errors.length, 1);
});
