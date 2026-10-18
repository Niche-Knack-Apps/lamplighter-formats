'use strict';
// Reads a Lamplighter resource file the way the app does and says what is wrong with it.
// No dependencies: plain checks, plain words.
const canon = require('./canon.json');

const KEY = /^\d+\.\d+\.\d+$/;
const STRONGS = /^[GH]\d+$/;
const RTL = /[֐-׿؀-ۿ܀-ݏ]/;

function detectKind(data) {
  if (!data || typeof data !== 'object') return 'unknown';
  if (Array.isArray(data.books)) return 'edition';
  if (Array.isArray(data.entries) && (data.type === 'commentary' || data.entries[0]?.range)) return 'commentary';
  if (data.meta && data.refs && typeof data.refs === 'object') return 'cross-references';
  if (data.meta && data.verses && typeof data.verses === 'object') return 'original-language';
  if (data.meta && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) return 'lexicon';
  return 'unknown';
}

function lint(data, { kind = detectKind(data) } = {}) {
  const report = { kind, errors: [], warnings: [], info: {} };
  const checker = { edition: lintEdition, commentary: lintCommentary, 'cross-references': lintCrossReferences, 'original-language': lintOriginalLanguage, lexicon: lintLexicon }[kind];
  if (!checker) {
    report.errors.push('Not a Lamplighter file: expected an edition ("books"), a commentary ("entries" with "type": "commentary"), cross-references ("meta" + "refs"), original-language words ("meta" + "verses") or a lexicon ("meta" + "entries").');
    return report;
  }
  checker(data, report);
  return report;
}

function lintEdition(data, report) {
  const { errors, warnings } = report;
  if (typeof data.name !== 'string' || !data.name.trim()) warnings.push('Give the edition a "name" (its full name, as readers will see it).');
  if (typeof data.abbreviation !== 'string' || !data.abbreviation.trim()) warnings.push('Give the edition an "abbreviation" (a short label such as "WEB").');
  if (typeof data.license !== 'string' || !data.license.trim()) warnings.push('State the "license" so readers know their rights (for example "Public Domain" or "CC BY 4.0").');
  if (data.textDirection !== undefined && !['ltr', 'rtl'].includes(data.textDirection)) errors.push('"textDirection" must be "ltr" or "rtl".');
  if (!data.books.length) { errors.push('"books" is empty.'); return; }
  const seen = new Set();
  let chapters = 0, verses = 0, chars = 0, empty = 0, rtlVerses = 0, sampled = 0;
  const canonDiffs = [];
  data.books.forEach((book, b) => {
    const where = `books[${b}]`;
    const name = typeof book.name === 'string' ? book.name : typeof book.book === 'string' ? book.book : '';
    if (!name.trim()) errors.push(`${where}: a book needs a "name".`);
    if (seen.has(name.toLowerCase())) errors.push(`${where}: the book "${name}" appears twice.`);
    seen.add(name.toLowerCase());
    const abbrev = book.abbrev ?? book.abbr;
    if (abbrev !== undefined && typeof abbrev !== 'string') errors.push(`${where} (${name}): "abbrev" must be a string.`);
    if (!Array.isArray(book.chapters) || !book.chapters.length) { errors.push(`${where} (${name}): "chapters" must be a non-empty array.`); return; }
    const known = canon.books.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (known && known.chapters.length !== book.chapters.length) canonDiffs.push(`${name} has ${book.chapters.length} chapters here; the usual count is ${known.chapters.length}`);
    book.chapters.forEach((chapter, c) => {
      const cwhere = `${name} chapter ${c + 1}`;
      chapters++;
      if (chapter.chapter !== undefined && chapter.chapter !== c + 1) errors.push(`${cwhere}: "chapter" is ${chapter.chapter}; chapters are read in order and must be numbered 1, 2, 3… (or leave the number out).`);
      if (!Array.isArray(chapter.verses)) { errors.push(`${cwhere}: "verses" must be an array.`); return; }
      if (!chapter.verses.length) warnings.push(`${cwhere} has no verses.`);
      if (known && known.chapters[c] !== undefined && known.chapters[c] !== chapter.verses.length && canonDiffs.length < 12) canonDiffs.push(`${cwhere} has ${chapter.verses.length} verses; the usual count is ${known.chapters[c]}`);
      chapter.verses.forEach((verse, v) => {
        verses++;
        if (verse === null || typeof verse !== 'object') { errors.push(`${cwhere} verse ${v + 1}: each verse is an object { "verse": n, "text": "…" }.`); return; }
        if (verse.verse !== undefined && verse.verse !== v + 1) errors.push(`${cwhere}: "verse" ${verse.verse} sits at position ${v + 1}. Verses are read by position: keep every number in order, and hold an absent verse's place with an empty "text".`);
        if (typeof verse.text !== 'string') { errors.push(`${cwhere} verse ${v + 1}: "text" must be a string.`); return; }
        if (!verse.text.trim()) empty++;
        chars += verse.text.length;
        if (sampled < 300 && verse.text.trim()) { sampled++; if (RTL.test(verse.text)) rtlVerses++; }
      });
    });
  });
  if (empty) warnings.push(`${empty} verse${empty === 1 ? '' : 's'} with empty text (fine for a verse the edition leaves out, or a skeleton still being filled).`);
  if (sampled && rtlVerses > sampled / 2 && data.textDirection !== 'rtl') warnings.push('The text reads right to left (Hebrew, Arabic or Syriac script); set "textDirection": "rtl" so the page lays it out that way.');
  if (sampled && rtlVerses <= sampled / 2 && data.textDirection === 'rtl') warnings.push('"textDirection" is "rtl" but the sampled text is not in a right-to-left script.');
  canonDiffs.forEach(d => warnings.push(`${d}. Other canons and versifications exist; this is a note, not a fault.`));
  report.info = { name: data.name || '', books: data.books.length, chapters, verses, characters: chars, emptyVerses: empty, textDirection: data.textDirection || 'ltr' };
}

function lintCommentary(data, report) {
  const { errors, warnings } = report;
  if (typeof data.name !== 'string' || !data.name.trim()) errors.push('A commentary needs a "name".');
  if (data.type !== 'commentary') warnings.push('Set "type": "commentary" so the app knows what it holds.');
  if (!Array.isArray(data.entries) || !data.entries.length) { errors.push('"entries" must be a non-empty array.'); return; }
  const isInt = n => Number.isInteger(n);
  data.entries.forEach((entry, i) => {
    const where = `entries[${i}]`;
    const start = entry?.range?.start;
    if (!start || !isInt(start.book_index) || start.book_index < 0) errors.push(`${where}: "range.start.book_index" (0 for the first book) is required.`);
    for (const [label, point] of [['start', start], ['end', entry?.range?.end]]) {
      if (!point) continue;
      if (point.chapter !== undefined && (!isInt(point.chapter) || point.chapter < 1)) errors.push(`${where}: "range.${label}.chapter" counts from 1.`);
      if (point.verse !== undefined && (!isInt(point.verse) || point.verse < 1)) errors.push(`${where}: "range.${label}.verse" counts from 1.`);
      if (point.verse !== undefined && point.chapter === undefined) errors.push(`${where}: "range.${label}" names a verse without a chapter.`);
    }
    if (typeof entry?.content !== 'string' || !entry.content.trim()) errors.push(`${where}: "content" must be a non-empty string.`);
  });
  report.info = { name: data.name || '', entries: data.entries.length };
}

function lintCrossReferences(data, report) {
  const { errors, warnings } = report;
  if (!data.meta?.name) warnings.push('Give "meta" a "name".');
  if (data.meta?.type !== 'cross_reference') warnings.push('Set "meta.type": "cross_reference".');
  let refs = 0;
  for (const [key, list] of Object.entries(data.refs)) {
    if (!KEY.test(key)) { errors.push(`refs: "${key}" is not a "<book_index>.<chapter>.<verse>" key (for example "0.1.1" is Genesis 1:1).`); continue; }
    if (!Array.isArray(list)) { errors.push(`refs["${key}"] must be an array.`); continue; }
    list.forEach((item, i) => {
      refs++;
      if (!item || !KEY.test(String(item.ref))) errors.push(`refs["${key}"][${i}]: "ref" must be a "<book_index>.<chapter>.<verse>" key.`);
      if (item?.endRef !== undefined && !KEY.test(String(item.endRef))) errors.push(`refs["${key}"][${i}]: "endRef" must be a "<book_index>.<chapter>.<verse>" key.`);
      if (item?.weight !== undefined && typeof item.weight !== 'number') errors.push(`refs["${key}"][${i}]: "weight" must be a number.`);
    });
  }
  report.info = { name: data.meta?.name || '', verses: Object.keys(data.refs).length, references: refs };
}

function lintOriginalLanguage(data, report) {
  const { errors } = report;
  let words = 0;
  for (const [key, list] of Object.entries(data.verses)) {
    if (!KEY.test(key)) { errors.push(`verses: "${key}" is not a "<book_index>.<chapter>.<verse>" key.`); continue; }
    if (!Array.isArray(list)) { errors.push(`verses["${key}"] must be an array of words.`); continue; }
    list.forEach((word, i) => {
      words++;
      if (typeof word?.word !== 'string') errors.push(`verses["${key}"][${i}]: "word" must be a string.`);
      if (word?.strongs !== undefined && !STRONGS.test(String(word.strongs))) errors.push(`verses["${key}"][${i}]: "strongs" looks like "G976" or "H121".`);
    });
  }
  report.info = { source: data.meta?.source || '', verses: Object.keys(data.verses).length, words };
}

function lintLexicon(data, report) {
  const { errors } = report;
  for (const [key, entry] of Object.entries(data.entries)) {
    if (!STRONGS.test(key)) errors.push(`entries: "${key}" is not a Strong's number such as "G1" or "H1".`);
    if (typeof entry?.def !== 'string') errors.push(`entries["${key}"]: "def" (the definition) must be a string.`);
  }
  report.info = { source: data.meta?.source || '', entries: Object.keys(data.entries).length };
}

module.exports = { detectKind, lint, canon };
