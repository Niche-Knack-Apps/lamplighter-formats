'use strict';
// Commentary packs: one commentary kept as a folder of small JSON files, so a reader loads only
// the parts that cover the passage on screen and drops the rest. _metadata.json says what the
// work is; _index.json lists the parts and, book by book and chapter by chapter, which parts hold
// the notes. lib/pack-reader.js is the lookup readers use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bookIds = require('./book-ids.json');
const { lint, lintEntries } = require('./validate');
const { METADATA, INDEX, partsFor, wholeBookParts } = require('./pack-reader');

const MAX_PART_BYTES = 256 * 1024;
// A note running on into a later book is indexed through this chapter of each book it reaches,
// as the app's own index does, since a pack does not know how many chapters a book has.
const LAST_CHAPTER = 150;

const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
const order = (a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]);
// A point without a chapter covers its whole book; without a verse, its whole chapter.
const startKey = p => [p.book_index, p.chapter ?? 0, p.verse ?? 0];
const endOf = range => range.end ?? range.start;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

const bookKey = value => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
const USFM = new Map();
for (const book of bookIds) for (const value of [book.usfm, book.osis, book.abbrev, book.name]) if (!USFM.has(bookKey(value))) USFM.set(bookKey(value), book.usfm.toLowerCase());

// A short file-name label for a book: its USFM code when the name is known, otherwise plain letters.
function slug(name) {
  if (USFM.has(bookKey(name))) return USFM.get(bookKey(name));
  const plain = String(name ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return plain || 'book';
}

function partText(entries) {
  return JSON.stringify({ type: 'commentary-part', formatVersion: 1, entries }) + '\n';
}

/* The finding aid: for each book the pack has notes on, the names its notes use, the parts with
   notes on the whole book, and for each chapter the parts with notes on it. A chapter lists a
   part as its number when any verse may need it, [part, first] when only verses from first on
   do, and [part, first, last] for those verses only. Parts are numbered from 0 in pack order. */
function indexOf(partEntries) {
  const books = new Map();
  const book = i => {
    if (!books.has(i)) books.set(i, { names: [], whole: new Set(), chapters: new Map() });
    return books.get(i);
  };
  partEntries.forEach((entries, n) => {
    for (const { range } of entries) {
      const start = range.start, end = endOf(range);
      for (const p of [start, end]) if (typeof p.book === 'string' && p.book.trim() && !book(p.book_index).names.includes(p.book)) book(p.book_index).names.push(p.book);
      if (start.chapter === undefined) { book(start.book_index).whole.add(n); continue; }
      for (let b = start.book_index; b <= end.book_index; b++) {
        const first = b === start.book_index ? start.chapter : 1;
        const last = b === end.book_index && end.chapter !== undefined ? end.chapter : Math.max(first, LAST_CHAPTER);
        for (let c = first; c <= last; c++) {
          const from = b === start.book_index && c === start.chapter ? start.verse ?? 1 : 1;
          const to = b === end.book_index && c === end.chapter && end.verse !== undefined ? end.verse : Infinity;
          const refs = book(b).chapters;
          if (!refs.has(c)) refs.set(c, new Map());
          const span = refs.get(c).get(n);
          refs.get(c).set(n, span ? [Math.min(span[0], from), Math.max(span[1], to)] : [from, to]);
        }
      }
    }
  });
  const out = {};
  for (const i of [...books.keys()].sort((x, y) => x - y)) {
    const { names, whole, chapters } = books.get(i);
    const entry = {};
    if (names.length) entry.names = names;
    if (whole.size) entry.whole = [...whole].sort((x, y) => x - y);
    entry.chapters = {};
    for (const c of [...chapters.keys()].sort((x, y) => x - y)) {
      entry.chapters[c] = [...chapters.get(c)].sort((x, y) => x[0] - y[0]).map(([n, [from, to]]) =>
        from <= 1 && to === Infinity ? n : to === Infinity ? [n, from] : [n, from, to]);
    }
    out[i] = entry;
  }
  return out;
}

// Group items by key, keeping first-seen order of keys and the items' own order within each group.
function group(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

const size = entries => entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
const pad = (n, width) => String(n).padStart(width, '0');

/* Split a commentary into its metadata, its index and part files. Each book is one part; a book over
   maxPartBytes becomes a part of its book-level entries plus runs of whole chapters, and a
   chapter over the limit is split between verses. Entries that start at the same place always
   share a part, and each part lists its entries in reading order of their starts. */
function split(commentary, { maxPartBytes = MAX_PART_BYTES } = {}) {
  const { name, type, formatVersion, entries, ...meta } = commentary;
  const overhead = Buffer.byteLength(partText([]));
  const parts = [];
  const add = (file, list) => {
    const text = partText(list);
    parts.push({ file, entries: list, entryCount: list.length, bytes: Buffer.byteLength(text), sha256: sha256(text), text });
  };
  const sorted = entries.map((entry, i) => [entry, i]).sort((a, b) => order(startKey(a[0].range.start), startKey(b[0].range.start)) || a[1] - b[1]).map(([entry]) => entry);
  for (const [bookIndex, list] of group(sorted, e => e.range.start.book_index)) {
    const label = `${pad(bookIndex, 3)}-${slug(meta.referenceBooks?.[bookIndex] ?? list[0].range.start.book)}`;
    if (overhead + size(list) <= maxPartBytes) { add(`${label}.json`, list); continue; }
    const whole = list.filter(e => e.range.start.chapter === undefined);
    if (whole.length) add(`${label}-book.json`, whole);
    const units = [];
    for (const [chapter, items] of group(list.filter(e => e.range.start.chapter !== undefined), e => e.range.start.chapter)) {
      if (overhead + size(items) <= maxPartBytes) { units.push({ label: pad(chapter, 3), items, bytes: size(items) }); continue; }
      for (const [verse, verseItems] of group(items, e => e.range.start.verse ?? 0)) units.push({ label: `${pad(chapter, 3)}.${verse}`, items: verseItems, bytes: size(verseItems) });
    }
    // Even parts rather than full ones followed by a small remainder
    const total = units.reduce((n, unit) => n + unit.bytes, 0);
    const target = total / Math.ceil(total / Math.max(1, maxPartBytes - overhead));
    let run = [], bytes = overhead, done = 0, made = 0;
    const flush = () => {
      if (!run.length) return;
      const first = run[0].label, last = run[run.length - 1].label;
      add(`${label}-${first}${last === first ? '' : `-${last}`}.json`, run.flatMap(unit => unit.items));
      run = []; bytes = overhead; made++;
    };
    for (const unit of units) {
      if (run.length && (bytes + unit.bytes > maxPartBytes || done + unit.bytes / 2 > target * (made + 1))) flush();
      run.push(unit); bytes += unit.bytes; done += unit.bytes;
    }
    flush();
  }
  const metadata = { name, type: 'commentary-pack', formatVersion: 1, ...meta, entryCount: entries.length };
  const index = {
    type: 'commentary-index',
    formatVersion: 1,
    parts: parts.map(({ file, entryCount, bytes, sha256 }) => ({ file, entryCount, bytes, sha256 })),
    books: indexOf(parts.map(part => part.entries))
  };
  return { metadata, index, parts: parts.map(({ file, text }) => ({ file, text })) };
}

const metadataText = metadata => JSON.stringify(metadata, null, 1) + '\n';

// One line per part and per book, so the index stays small and still reads well.
function indexText(index) {
  const { type, formatVersion, parts, books, ...rest } = index;
  const lines = Object.entries(books).map(([key, book]) => `  ${JSON.stringify(key)}: ${JSON.stringify(book)}`);
  return `{\n "type": ${JSON.stringify(type)},\n "formatVersion": ${JSON.stringify(formatVersion)},\n` +
    Object.entries(rest).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`).join('') +
    ` "parts": [\n${parts.map(part => `  ${JSON.stringify(part)}`).join(',\n')}\n ],\n` +
    ` "books": {\n${lines.join(',\n')}\n }\n}\n`;
}

// The single commentary file a pack holds; entries come out in the parts' order.
function join(metadata, parts) {
  const { type, formatVersion, entryCount, name, ...meta } = metadata;
  return { name, type: 'commentary', formatVersion: 1, ...meta, entries: parts.flatMap(part => part.entries) };
}

function packFolder(target) {
  if (fs.statSync(target).isDirectory()) return target;
  return path.dirname(target);
}

function decode(raw) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new Error('the file is not valid UTF-8'); }
  try { return JSON.parse(text); } catch (error) { throw new Error(`not valid JSON (${error.message})`); }
}

function readPackFile(dir, name, kind, report) {
  let data;
  try { data = decode(fs.readFileSync(path.join(dir, name))); }
  catch (error) {
    report.errors.push(error.code === 'ENOENT' ? `${dir} holds no ${name}; a commentary pack is a folder with ${METADATA}, ${INDEX} and its part files.` : `${name}: ${error.message}`);
    return null;
  }
  const own = lint(data, { kind });
  if (data?.type !== kind) own.errors.unshift(`"type" must be "${kind}".`);
  report.errors.push(...own.errors.map(e => `${name}: ${e}`));
  report.warnings.push(...own.warnings.map(w => `${name}: ${w}`));
  return own.errors.length ? null : data;
}

// Where two indexes differ, chapter by chapter, in words.
function indexDifferences(stored, expected) {
  const out = [];
  const keys = new Set([...Object.keys(stored), ...Object.keys(expected)]);
  for (const b of [...keys].sort((x, y) => x - y)) {
    const have = stored[b] ?? { chapters: {} }, want = expected[b] ?? { chapters: {} };
    const label = (want.names ?? have.names ?? [`book ${b}`])[0];
    if (JSON.stringify(have.names ?? []) !== JSON.stringify(want.names ?? [])) out.push(`${label}: "names" is ${JSON.stringify(have.names ?? [])}; the parts use ${JSON.stringify(want.names ?? [])}.`);
    if (JSON.stringify(have.whole ?? []) !== JSON.stringify(want.whole ?? [])) out.push(`${label}: "whole" is ${JSON.stringify(have.whole ?? [])}; the parts need ${JSON.stringify(want.whole ?? [])}.`);
    const chapters = new Set([...Object.keys(have.chapters ?? {}), ...Object.keys(want.chapters ?? {})]);
    for (const c of [...chapters].sort((x, y) => x - y)) {
      const a = JSON.stringify(have.chapters?.[c] ?? []), b2 = JSON.stringify(want.chapters?.[c] ?? []);
      if (a !== b2) out.push(`${label} ${c} (books["${b}"].chapters["${c}"]) is ${a}; the parts need ${b2}.`);
    }
  }
  return out;
}

/* Check a pack folder: the metadata, the index, then every part against the index (size,
   checksum, entries) and the index against the parts' notes. Returns a lint report; with
   { keep: true } the report also carries the metadata and the parsed parts, for join. */
function verify(target, { keep = false } = {}) {
  const dir = packFolder(target);
  const report = { kind: 'commentary-pack', errors: [], warnings: [], info: {} };
  const metadata = readPackFile(dir, METADATA, 'commentary-pack', report);
  const index = readPackFile(dir, INDEX, 'commentary-index', report);
  if (!metadata || !index) return report;
  const counted = index.parts.reduce((n, part) => n + part.entryCount, 0);
  if (metadata.entryCount !== counted) report.errors.push(`${METADATA}: "entryCount" is ${metadata.entryCount}; the parts in ${INDEX} hold ${counted}.`);
  const loaded = [];
  let largest = 0;
  for (const part of index.parts) {
    const where = part.file;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, part.file)); }
    catch { report.errors.push(`${where}: listed in ${INDEX} but not in the folder.`); continue; }
    largest = Math.max(largest, raw.length);
    if (raw.length !== part.bytes) report.errors.push(`${where}: ${raw.length} bytes; ${INDEX} says ${part.bytes}.`);
    if (sha256(raw) !== part.sha256) { report.errors.push(`${where}: its sha256 does not match ${INDEX}; the file has changed or is damaged.`); continue; }
    let data;
    try { data = decode(raw); } catch (error) { report.errors.push(`${where}: ${error.message}`); continue; }
    const partReport = lint(data, { kind: 'commentary-part' });
    if (data?.type !== 'commentary-part') partReport.errors.unshift('"type" must be "commentary-part".');
    if (partReport.errors.length) { report.errors.push(...partReport.errors.map(e => `${where}: ${e}`)); continue; }
    lintEntries(data.entries, metadata.referenceBooks, report.errors, `${where} `);
    if (data.entries.length !== part.entryCount) report.errors.push(`${where}: holds ${data.entries.length} entries; ${INDEX} says ${part.entryCount}.`);
    if (raw.length > MAX_PART_BYTES) report.warnings.push(`${where} is ${raw.length} bytes. A reader loads a whole part at once; parts of ${MAX_PART_BYTES} bytes or less suit phones.`);
    loaded.push(data);
  }
  // The index must find every note, and nothing else: rebuild it from the parts and compare.
  if (loaded.length === index.parts.length) {
    const differences = indexDifferences(index.books, indexOf(loaded.map(part => part.entries)));
    report.errors.push(...differences.slice(0, 20).map(d => `${INDEX}: ${d}`));
    if (differences.length > 20) report.errors.push(`${INDEX}: ${differences.length - 20} more differences from the parts.`);
  }
  const listed = new Set(index.parts.map(part => part.file));
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.json') && name !== METADATA && name !== INDEX && !listed.has(name)) report.warnings.push(`${name} is in the folder but not listed in ${INDEX}.`);
  }
  report.info = { name: metadata.name, parts: index.parts.length, entries: counted, bytes: index.parts.reduce((n, part) => n + part.bytes, 0), largestPart: largest };
  if (keep && !report.errors.length) Object.assign(report, { metadata, index, parts: loaded });
  return report;
}

// Write a pack into a new or empty folder. Existing files are never replaced. The metadata goes
// last, so a reader that finds a pack by its _metadata.json never sees a half-written one.
function write(dir, commentary, options) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty; choose a new folder.`);
  const { metadata, index, parts } = split(commentary, options);
  fs.mkdirSync(dir, { recursive: true });
  for (const part of parts) fs.writeFileSync(path.join(dir, part.file), part.text, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, INDEX), indexText(index), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, METADATA), metadataText(metadata), { flag: 'wx' });
  return { metadata, index };
}

module.exports = { METADATA, INDEX, MAX_PART_BYTES, split, join, partsFor, wholeBookParts, verify, write, metadataText, indexText };
