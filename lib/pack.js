'use strict';
// Commentary packs: one commentary kept as a folder of small JSON files, so a reader loads only
// the parts that cover the passage on screen and drops the rest. pack.json lists the parts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bookIds = require('./book-ids.json');
const { lint, lintEntries } = require('./validate');

const MANIFEST = 'pack.json';
const MAX_PART_BYTES = 2 * 1024 * 1024;

const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
const order = (a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]);
// A point without a chapter covers its whole book; without a verse, its whole chapter.
const startKey = p => [p.book_index, p.chapter ?? 0, p.verse ?? 0];
const endKey = p => [p.book_index, p.chapter ?? Infinity, p.verse ?? Infinity];
const endOf = range => range.end ?? range.start;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const point = p => Object.fromEntries(['book', 'book_index', 'chapter', 'verse'].filter(k => p[k] !== undefined).map(k => [k, p[k]]));

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

// The span a part covers: from its earliest entry start to its latest entry end.
function span(entries) {
  let start = entries[0].range.start, end = endOf(entries[0].range);
  for (const { range } of entries) {
    if (order(startKey(range.start), startKey(start)) < 0) start = range.start;
    if (order(endKey(endOf(range)), endKey(end)) > 0) end = endOf(range);
  }
  return { start: point(start), end: point(end) };
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

/* Split a commentary into a manifest and part files. Each book is one part; a book over
   maxPartBytes becomes a part of its book-level entries plus runs of whole chapters, and a
   chapter over the limit is split between verses. Entries that start at the same place always
   share a part, and each part lists its entries in reading order of their starts. */
function split(commentary, { maxPartBytes = MAX_PART_BYTES } = {}) {
  const { name, type, formatVersion, entries, ...meta } = commentary;
  const overhead = Buffer.byteLength(partText([]));
  const parts = [];
  const add = (file, list) => {
    const text = partText(list);
    parts.push({ file, range: span(list), entryCount: list.length, bytes: Buffer.byteLength(text), sha256: sha256(text), text });
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
  const manifest = { name, type: 'commentary-pack', formatVersion: 1, ...meta, entryCount: entries.length, parts: parts.map(({ text, ...part }) => part) };
  return { manifest, parts: parts.map(({ file, text }) => ({ file, text })) };
}

// The single commentary file a pack holds; entries come out in the parts' order.
function join(manifest, parts) {
  const { type, formatVersion, entryCount, parts: listed, name, ...meta } = manifest;
  return { name, type: 'commentary', formatVersion: 1, ...meta, entries: parts.flatMap(part => part.entries) };
}

// The parts a reader needs for a passage: those whose range overlaps it. Points are
// { book_index, chapter?, verse? } in the commentary's own numbering.
function partsFor(manifest, start, end = start) {
  return manifest.parts.filter(part => order(startKey(part.range.start), endKey(end)) <= 0 && order(endKey(part.range.end), startKey(start)) >= 0);
}

function manifestPath(target) {
  return fs.statSync(target).isDirectory() ? path.join(target, MANIFEST) : target;
}

function decode(raw) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new Error('the file is not valid UTF-8'); }
  try { return JSON.parse(text); } catch (error) { throw new Error(`not valid JSON (${error.message})`); }
}

/* Check a pack folder: the manifest, then every part against it (size, checksum, entries,
   and that each entry lies inside its part's range). Returns a lint report; with { keep: true }
   the report also carries the parsed parts, for join. */
function verify(target, { keep = false } = {}) {
  const file = manifestPath(target);
  const dir = path.dirname(file);
  const report = { kind: 'commentary-pack', errors: [], warnings: [], info: {} };
  let manifest;
  try { manifest = decode(fs.readFileSync(file)); }
  catch (error) { report.errors.push(error.code === 'ENOENT' ? `${dir} holds no ${MANIFEST}; a commentary pack is a folder with ${MANIFEST} and its parts.` : `${MANIFEST}: ${error.message}`); return report; }
  Object.assign(report, lint(manifest, { kind: 'commentary-pack' }));
  if (manifest?.type !== 'commentary-pack') report.errors.unshift(`"type" must be "commentary-pack" in ${MANIFEST}.`);
  if (report.errors.length) return report;
  const loaded = [];
  let largest = 0;
  for (const part of manifest.parts) {
    const where = part.file;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, part.file)); }
    catch { report.errors.push(`${where}: listed in ${MANIFEST} but not in the folder.`); continue; }
    largest = Math.max(largest, raw.length);
    if (raw.length !== part.bytes) report.errors.push(`${where}: ${raw.length} bytes; ${MANIFEST} says ${part.bytes}.`);
    if (sha256(raw) !== part.sha256) { report.errors.push(`${where}: its sha256 does not match ${MANIFEST}; the file has changed or is damaged.`); continue; }
    let data;
    try { data = decode(raw); } catch (error) { report.errors.push(`${where}: ${error.message}`); continue; }
    const partReport = lint(data, { kind: 'commentary-part' });
    if (data?.type !== 'commentary-part') partReport.errors.unshift('"type" must be "commentary-part".');
    if (partReport.errors.length) { report.errors.push(...partReport.errors.map(e => `${where}: ${e}`)); continue; }
    lintEntries(data.entries, manifest.referenceBooks, report.errors, `${where} `);
    if (data.entries.length !== part.entryCount) report.errors.push(`${where}: holds ${data.entries.length} entries; ${MANIFEST} says ${part.entryCount}.`);
    data.entries.forEach((entry, i) => {
      if (order(startKey(entry.range.start), startKey(part.range.start)) < 0 || order(endKey(endOf(entry.range)), endKey(part.range.end)) > 0) report.errors.push(`${where} entries[${i}]: lies outside the part's range in ${MANIFEST}.`);
    });
    if (raw.length > MAX_PART_BYTES) report.warnings.push(`${where} is ${raw.length} bytes. A reader loads a whole part at once; parts of ${MAX_PART_BYTES} bytes or less suit phones.`);
    if (keep) loaded.push(data);
  }
  const listed = new Set(manifest.parts.map(part => part.file));
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.json') && name !== path.basename(file) && !listed.has(name)) report.warnings.push(`${name} is in the folder but not listed in ${MANIFEST}.`);
  }
  report.info = { ...report.info, largestPart: largest };
  if (keep && !report.errors.length) Object.assign(report, { manifest, parts: loaded });
  return report;
}

// Write a pack into a new or empty folder. Existing files are never replaced.
function write(dir, commentary, options) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty; choose a new folder.`);
  const { manifest, parts } = split(commentary, options);
  fs.mkdirSync(dir, { recursive: true });
  for (const part of parts) fs.writeFileSync(path.join(dir, part.file), part.text, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 1) + '\n', { flag: 'wx' });
  return manifest;
}

module.exports = { MANIFEST, MAX_PART_BYTES, split, join, partsFor, verify, write };
