'use strict';
// Reads a Lamplighter resource file the way the app does and says what is wrong with it.
// No dependencies: plain checks, plain words.
const canon = require('./canon.json');
const bookIds = require('./book-ids.json');
const Versification = require('./versification.js');

const KEY = /^(0|[1-9]\d*)\.[1-9]\d*\.[1-9]\d*$/;
const PART_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const STRONGS = /^[GH]\d+$/;
const RTL = /[֐-׿؀-ۿ܀-ݏ]/;

function detectKind(data) {
  if (!object(data)) return 'unknown';
  if (data.type === 'commentary-pack') return 'commentary-pack';
  if (data.type === 'commentary-part') return 'commentary-part';
  if (Array.isArray(data.books)) return 'edition';
  if (Array.isArray(data.entries) && (data.type === 'commentary' || data.entries[0]?.range)) return 'commentary';
  if (object(data.meta) && object(data.refs)) return 'cross-references';
  if (object(data.meta) && object(data.verses)) return 'original-language';
  if (object(data.meta) && object(data.entries)) return 'lexicon';
  return 'unknown';
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const order = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function lintMetadata(data, report) {
  for (const field of ['name', 'abbreviation', 'language', 'languageEnglishName', 'license', 'license_url', 'attribution', 'versification']) {
    if (data[field] !== undefined && typeof data[field] !== 'string') report.errors.push(`"${field}" must be a string.`);
  }
  if (data.formatVersion !== undefined && data.formatVersion !== 1) report.errors.push('Unsupported "formatVersion"; this tool supports version 1 and unversioned legacy files.');
  if (data.textDirection !== undefined && !['ltr', 'rtl'].includes(data.textDirection)) report.errors.push('"textDirection" must be "ltr" or "rtl".');
  if (data.referenceBooks !== undefined && (!Array.isArray(data.referenceBooks) || !data.referenceBooks.length || data.referenceBooks.some(v => typeof v !== 'string' || !v.trim()) || new Set(data.referenceBooks).size !== data.referenceBooks.length)) report.errors.push('"referenceBooks" must list unique non-empty book names in the matching edition\'s actual order.');
  if (data.source !== undefined && !object(data.source)) report.errors.push('"source" must be a provenance object.');
  if (object(data.source)) {
    for (const field of ['name', 'url', 'format']) if (data.source[field] !== undefined && typeof data.source[field] !== 'string') report.errors.push(`source.${field} must be a string.`);
    if (data.source.sha256 !== undefined && (typeof data.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.source.sha256))) report.errors.push('source.sha256 must contain 64 lowercase hexadecimal characters.');
  }
}

function lint(data, { kind = detectKind(data) } = {}) {
  const report = { kind, errors: [], warnings: [], info: {} };
  const checker = { edition: lintEdition, commentary: lintCommentary, 'commentary-pack': lintCommentaryPack, 'commentary-part': lintCommentaryPart, 'cross-references': lintCrossReferences, 'original-language': lintOriginalLanguage, lexicon: lintLexicon }[kind];
  if (!checker) {
    report.errors.push('Not a Lamplighter file: expected an edition ("books"), a commentary ("entries" with "type": "commentary"), cross-references ("meta" + "refs"), original-language words ("meta" + "verses") or a lexicon ("meta" + "entries").');
    return report;
  }
  if (!object(data)) { report.errors.push('A resource must be a JSON object.'); return report; }
  lintMetadata(data, report);
  checker(data, report);
  return report;
}

function lintEdition(data, report) {
  const { errors, warnings } = report;
  if (typeof data.name !== 'string' || !data.name.trim()) warnings.push('Give the edition a "name" (its full name, as readers will see it).');
  if (typeof data.abbreviation !== 'string' || !data.abbreviation.trim()) warnings.push('Give the edition an "abbreviation" (a short label such as "WEB").');
  if (typeof data.license !== 'string' || !data.license.trim()) warnings.push('State the "license" so readers know their rights (for example "Public Domain" or "CC BY 4.0").');
  if (data.textDirection !== undefined && !['ltr', 'rtl'].includes(data.textDirection)) errors.push('"textDirection" must be "ltr" or "rtl".');
  if (!Array.isArray(data.books) || !data.books.length) { errors.push('"books" is empty or is not an array.'); return; }
  const seen = new Set();
  let chapters = 0, verses = 0, chars = 0, empty = 0, rtlVerses = 0, sampled = 0;
  const canonDiffs = [];
  data.books.forEach((book, b) => {
    const where = `books[${b}]`;
    if (!object(book)) { errors.push(`${where}: a book must be an object.`); return; }
    for (const field of ['name', 'book', 'abbrev', 'abbr', 'osis']) if (book[field] !== undefined && typeof book[field] !== 'string') errors.push(`${where}: "${field}" must be a string.`);
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
      if (!object(chapter)) { errors.push(`${cwhere}: a chapter must be an object.`); return; }
      if (chapter.chapter !== undefined && chapter.chapter !== c + 1) errors.push(`${cwhere}: "chapter" is ${chapter.chapter}; chapters are read in order and must be numbered 1, 2, 3… (or leave the number out).`);
      if (!Array.isArray(chapter.verses)) { errors.push(`${cwhere}: "verses" must be an array.`); return; }
      if (!chapter.verses.length) warnings.push(`${cwhere} has no verses.`);
      if (known && known.chapters[c] !== undefined && known.chapters[c] !== chapter.verses.length && canonDiffs.length < 12) canonDiffs.push(`${cwhere} has ${chapter.verses.length} verses; the usual count is ${known.chapters[c]}`);
      chapter.verses.forEach((verse, v) => {
        verses++;
        if (!object(verse)) { errors.push(`${cwhere} verse ${v + 1}: each verse is an object { "verse": n, "text": "…" }.`); return; }
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
  const numbering = detectVersification(data);
  const declared = typeof data.versification === 'string' ? Versification.normalize(data.versification) : null;
  if (!numbering.scheme) warnings.push('The chapter and verse counts match no numbering Lamplighter knows (English, Original or Vulgate), so notes and cross-references may land a verse off. Declare "versification" if you know it.');
  else if (declared && numbering.evidence >= 3 && declared !== numbering.scheme) warnings.push(`"versification" is "${data.versification}", but the chapter and verse counts match the ${SCHEME_NAMES[numbering.scheme]} numbering.`);
  report.info = { name: data.name || '', books: data.books.length, chapters, verses, characters: chars, emptyVerses: empty, textDirection: data.textDirection || 'ltr', versification: numbering.scheme || 'unrecognized' };
}

const SCHEME_NAMES = { eng: 'English', org: 'Original (Hebrew and Greek)', vul: 'Vulgate' };
const bookKey = value => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
const BOOK_KEYS = new Map();
for (const book of bookIds) for (const value of [book.usfm, book.osis, book.abbrev, book.name]) if (!BOOK_KEYS.has(bookKey(value))) BOOK_KEYS.set(bookKey(value), book.usfm);

// Which numbering the edition's own chapter and verse counts match.
function detectVersification(data) {
  const counts = new Map();
  for (const book of data.books) {
    if (!object(book) || !Array.isArray(book.chapters)) continue;
    const id = [book.abbrev, book.abbr, book.osis, book.name, book.book].map(v => BOOK_KEYS.get(bookKey(v))).find(Boolean);
    if (id && !counts.has(id)) counts.set(id, book.chapters.map(chapter => (object(chapter) && Array.isArray(chapter.verses) ? chapter.verses.length : 0)));
  }
  return Versification.detect(id => counts.get(id) || null);
}

function lintCommentary(data, report) {
  const { errors, warnings } = report;
  if (typeof data.name !== 'string' || !data.name.trim()) errors.push('A commentary needs a "name".');
  if (data.type !== 'commentary') warnings.push('Set "type": "commentary" so the app knows what it holds.');
  if (!Array.isArray(data.entries) || !data.entries.length) { errors.push('"entries" must be a non-empty array.'); return; }
  lintEntries(data.entries, data.referenceBooks, errors);
  report.info = { name: data.name || '', entries: data.entries.length };
}

function lintRange(range, where, referenceBooks, errors) {
  const isInt = n => Number.isInteger(n);
  const start = range?.start;
  if (!start || !isInt(start.book_index) || start.book_index < 0) errors.push(`${where}: "range.start.book_index" (0 for the first book) is required.`);
  for (const [label, point] of [['start', start], ['end', range?.end]]) {
    if (point === undefined) continue;
    if (!object(point)) { errors.push(`${where}: "range.${label}" must be an object.`); continue; }
    if (!object(point) || !isInt(point.book_index) || point.book_index < 0) errors.push(`${where}: "range.${label}.book_index" must be a nonnegative integer.`);
    if (point.chapter !== undefined && (!isInt(point.chapter) || point.chapter < 1)) errors.push(`${where}: "range.${label}.chapter" counts from 1.`);
    if (point.verse !== undefined && (!isInt(point.verse) || point.verse < 1)) errors.push(`${where}: "range.${label}.verse" counts from 1.`);
    if (point.verse !== undefined && point.chapter === undefined) errors.push(`${where}: "range.${label}" names a verse without a chapter.`);
    if (Array.isArray(referenceBooks) && point.book_index >= referenceBooks.length) errors.push(`${where}: "range.${label}.book_index" is outside referenceBooks.`);
  }
  const end = range?.end;
  if (object(start) && object(end) && order([start.book_index, start.chapter ?? 0, start.verse ?? 0], [end.book_index, end.chapter ?? Infinity, end.verse ?? Infinity]) > 0) errors.push(`${where}: the range end precedes its start.`);
}

function lintEntries(entries, referenceBooks, errors, prefix = '') {
  entries.forEach((entry, i) => {
    const where = `${prefix}entries[${i}]`;
    lintRange(entry?.range, where, referenceBooks, errors);
    if (entry?.title !== undefined && typeof entry.title !== 'string') errors.push(`${where}: "title" must be a string.`);
    if (typeof entry?.content !== 'string' || !entry.content.trim()) errors.push(`${where}: "content" must be a non-empty string.`);
  });
}

// The pack.json of a commentary pack. lib/pack.js checks the part files against it.
function lintCommentaryPack(data, report) {
  const { errors } = report;
  if (typeof data.name !== 'string' || !data.name.trim()) errors.push('A commentary pack needs a "name".');
  if (data.formatVersion !== 1) errors.push('A commentary pack needs "formatVersion": 1.');
  if (!Array.isArray(data.parts) || !data.parts.length) { errors.push('"parts" must be a non-empty array.'); return; }
  const isCount = n => Number.isInteger(n) && n >= 1;
  const files = new Set();
  let entries = 0, bytes = 0;
  data.parts.forEach((part, i) => {
    const where = `parts[${i}]`;
    if (!object(part)) { errors.push(`${where}: a part must be an object.`); return; }
    if (typeof part.file !== 'string' || !PART_FILE.test(part.file) || part.file === 'pack.json') errors.push(`${where}: "file" must be a plain file name ending in .json (letters, digits, ".", "_", "-"; no folders), other than pack.json.`);
    else if (files.has(part.file)) errors.push(`${where}: "${part.file}" is listed twice.`);
    files.add(part.file);
    if (!object(part.range) || !object(part.range.end)) errors.push(`${where}: "range" needs "start" and "end".`);
    lintRange(part.range, where, data.referenceBooks, errors);
    if (!isCount(part.entryCount)) errors.push(`${where}: "entryCount" must be a positive integer.`);
    if (!isCount(part.bytes)) errors.push(`${where}: "bytes" must be a positive integer.`);
    if (typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)) errors.push(`${where}: "sha256" must contain 64 lowercase hexadecimal characters.`);
    if (isCount(part.entryCount)) entries += part.entryCount;
    if (isCount(part.bytes)) bytes += part.bytes;
  });
  if (data.entryCount !== entries) errors.push(`"entryCount" is ${JSON.stringify(data.entryCount)}; the parts hold ${entries}.`);
  report.info = { name: data.name || '', parts: data.parts.length, entries, bytes };
}

function lintCommentaryPart(data, report) {
  const { errors } = report;
  if (data.formatVersion !== 1) errors.push('A commentary part needs "formatVersion": 1.');
  if (!Array.isArray(data.entries) || !data.entries.length) { errors.push('"entries" must be a non-empty array.'); return; }
  lintEntries(data.entries, undefined, errors);
  report.info = { entries: data.entries.length };
}

function lintCrossReferences(data, report) {
  const { errors, warnings } = report;
  if (!data.meta?.name) warnings.push('Give "meta" a "name".');
  if (data.meta?.type !== 'cross_reference') warnings.push('Set "meta.type": "cross_reference".');
  let refs = 0;
  if (!object(data.meta) || !object(data.refs)) { errors.push('Cross-references need "meta" and "refs" objects.'); return; }
  for (const [key, list] of Object.entries(data.refs)) {
    if (!KEY.test(key)) { errors.push(`refs: "${key}" is not a "<book_index>.<chapter>.<verse>" key (for example "0.1.1" is Genesis 1:1).`); continue; }
    if (!Array.isArray(list)) { errors.push(`refs["${key}"] must be an array.`); continue; }
    list.forEach((item, i) => {
      refs++;
      if (!item || typeof item.ref !== 'string' || !KEY.test(item.ref)) errors.push(`refs["${key}"][${i}]: "ref" must be a "<book_index>.<chapter>.<verse>" key.`);
      if (item?.endRef !== undefined && (typeof item.endRef !== 'string' || !KEY.test(item.endRef))) errors.push(`refs["${key}"][${i}]: "endRef" must be a "<book_index>.<chapter>.<verse>" key.`);
      if (item?.weight !== undefined && !Number.isFinite(item.weight)) errors.push(`refs["${key}"][${i}]: "weight" must be a finite number.`);
      if (typeof item?.ref === 'string' && typeof item?.endRef === 'string' && KEY.test(item.ref) && KEY.test(item.endRef) && order(item.ref.split('.').map(Number), item.endRef.split('.').map(Number)) > 0) errors.push(`refs["${key}"][${i}]: the range end precedes its start.`);
    });
  }
  report.info = { name: data.meta?.name || '', verses: Object.keys(data.refs).length, references: refs };
}

function lintOriginalLanguage(data, report) {
  const { errors } = report;
  let words = 0;
  if (!object(data.meta) || !object(data.verses)) { errors.push('Original-language data needs "meta" and "verses" objects.'); return; }
  for (const [key, list] of Object.entries(data.verses)) {
    if (!KEY.test(key)) { errors.push(`verses: "${key}" is not a "<book_index>.<chapter>.<verse>" key.`); continue; }
    if (!Array.isArray(list)) { errors.push(`verses["${key}"] must be an array of words.`); continue; }
    list.forEach((word, i) => {
      words++;
      if (typeof word?.word !== 'string') errors.push(`verses["${key}"][${i}]: "word" must be a string.`);
      if (word?.strongs !== undefined && !STRONGS.test(String(word.strongs))) errors.push(`verses["${key}"][${i}]: "strongs" looks like "G976" or "H121".`);
      for (const field of ['lemma', 'pos', 'morph', 'morphDesc']) if (word?.[field] !== undefined && typeof word[field] !== 'string') errors.push(`verses["${key}"][${i}]: "${field}" must be a string.`);
      if (word?.wordIndex !== undefined && (!Number.isInteger(word.wordIndex) || word.wordIndex < 0)) errors.push(`verses["${key}"][${i}]: "wordIndex" must be a nonnegative integer.`);
    });
  }
  report.info = { source: data.meta?.source || '', verses: Object.keys(data.verses).length, words };
}

function lintLexicon(data, report) {
  const { errors } = report;
  if (!object(data.meta) || !object(data.entries)) { errors.push('Lexicons need "meta" and "entries" objects.'); return; }
  for (const [key, entry] of Object.entries(data.entries)) {
    if (!STRONGS.test(key)) errors.push(`entries: "${key}" is not a Strong's number such as "G1" or "H1".`);
    if (typeof entry?.def !== 'string') errors.push(`entries["${key}"]: "def" (the definition) must be a string.`);
  }
  report.info = { source: data.meta?.source || '', entries: Object.keys(data.entries).length };
}

module.exports = { detectKind, lint, lintEntries, canon, detectVersification };
