#!/usr/bin/env node
'use strict';
// lamplighter-formats: lint, start and describe the JSON files Lamplighter reads.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lint, detectKind } = require('../lib/validate');
const { newEdition } = require('../lib/skeleton');
const pack = require('../lib/pack');

const USAGE = `lamplighter-formats <command> [options]

  lint <file…> [--json]        Read each file as the app does and report errors and warnings.
                               A commentary pack is checked by its folder, _metadata.json or _index.json.
  new "<name>" --out FILE      Start an edition: every book, chapter and verse in place, texts empty.
      [--abbreviation ABBR] [--language eng] [--language-name English]
      [--license "Public Domain"] [--license-url URL] [--rtl] [--books all|ot|nt|"Genesis,John"]
  info <file>                  Counts and facts about a file or a commentary pack.
  pack <commentary.json> --out DIR [--max-part-bytes 256K]
      Split a commentary into a pack: _metadata.json, _index.json and small part files a reader
      loads as needed.
  unpack <DIR> --out FILE      Check a pack and join it back into one commentary file.
  convert <file…> --from FORMAT --out FILE [--name NAME] [options]
      Import text/vpl, lines, docx/doc, usfm/usx, osis, sword, or normalize json.
      Run "convert --help" for formats, layout, commentary, and loss-report options.

Exit status: 0 when nothing is wrong, 1 when a file has errors, 2 for a bad command line.`;

function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function read(file) {
  let raw = fs.readFileSync(file);
  const bom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  if (bom) raw = raw.subarray(3);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new Error('the file is not valid UTF-8'); }
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`not valid JSON (${error.message})`); }
  return { data, bom };
}

// Lint one path: a resource file, or a commentary pack by its folder, _metadata.json or _index.json.
function check(file) {
  if (fs.statSync(file).isDirectory()) return pack.verify(file);
  const { data, bom } = read(file);
  if (['commentary-pack', 'commentary-index'].includes(detectKind(data))) return pack.verify(file);
  const report = lint(data);
  if (bom) report.warnings.unshift('The file starts with a byte-order mark; plain UTF-8 without it is safer.');
  if (report.kind === 'commentary-part') report.warnings.push(`This is one part of a commentary pack; lint the folder holding ${pack.METADATA} to check the whole.`);
  return report;
}

function cmdLint(opts) {
  if (!opts._.length) { console.error(USAGE); return 2; }
  let failed = false;
  const reports = [];
  for (const file of opts._) {
    let report;
    try {
      report = check(file);
    } catch (error) {
      report = { kind: 'unknown', errors: [error.message], warnings: [], info: {} };
    }
    reports.push({ file, ...report });
    if (report.errors.length) failed = true;
    if (!opts.json) {
      console.log(`${file}: ${report.kind} · ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} · ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`);
      for (const e of report.errors) console.log(`  error    ${e}`);
      for (const w of report.warnings) console.log(`  warning  ${w}`);
      const facts = Object.entries(report.info).map(([k, v]) => `${k} ${v}`).join(' · ');
      if (facts) console.log(`  ${facts}`);
    }
  }
  if (opts.json) console.log(JSON.stringify(reports, null, 2));
  return failed ? 1 : 0;
}

function cmdNew(opts) {
  const name = opts._[0];
  if (!name || !opts.out) { console.error(USAGE); return 2; }
  const books = typeof opts.books === 'string' && !['all', 'ot', 'nt'].includes(opts.books) ? opts.books.split(',').map(s => s.trim()).filter(Boolean) : (opts.books || 'all');
  const edition = newEdition({ name, abbreviation: opts.abbreviation || '', language: opts.language || '', languageEnglishName: opts['language-name'] || '', license: opts.license || '', licenseUrl: opts['license-url'] || '', textDirection: opts.rtl ? 'rtl' : 'ltr', books });
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(edition, null, 1) + '\n');
  const chapters = edition.books.reduce((n, b) => n + b.chapters.length, 0);
  const verses = edition.books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.verses.length, 0), 0);
  console.log(`${opts.out}: ${edition.books.length} books, ${chapters} chapters, ${verses} verses, texts empty. Fill the texts, then: lamplighter-formats lint ${opts.out}`);
  return 0;
}

function cmdInfo(opts) {
  const file = opts._[0];
  if (!file) { console.error(USAGE); return 2; }
  const report = check(file);
  console.log(JSON.stringify({ file, kind: report.kind, ...report.info, errors: report.errors.length, warnings: report.warnings.length }, null, 2));
  return 0;
}

function bytes(value) {
  const m = /^(\d+)([KM]?)$/i.exec(String(value));
  return m ? Number(m[1]) * { '': 1, k: 1024, m: 1024 * 1024 }[m[2].toLowerCase()] : NaN;
}

function cmdPack(opts) {
  const file = opts._[0];
  const max = opts['max-part-bytes'] === undefined ? pack.MAX_PART_BYTES : bytes(opts['max-part-bytes']);
  if (!file || typeof opts.out !== 'string' || !(max > 0)) { console.error(USAGE); return 2; }
  const { data } = read(file);
  const report = lint(data);
  if (report.kind !== 'commentary' || report.errors.length) {
    console.error(`${file}: only a commentary that lints without errors can be packed (this is ${report.kind}, ${report.errors.length} error${report.errors.length === 1 ? '' : 's'}).`);
    return 1;
  }
  const { metadata, index } = pack.write(opts.out, data, { maxPartBytes: max });
  const largest = Math.max(...index.parts.map(part => part.bytes));
  console.log(`${opts.out}: ${index.parts.length} parts, ${metadata.entryCount} entries, largest part ${largest} bytes. Check it: lamplighter-formats lint ${opts.out}`);
  return 0;
}

function cmdUnpack(opts) {
  const target = opts._[0];
  if (!target || typeof opts.out !== 'string') { console.error(USAGE); return 2; }
  if (fs.existsSync(opts.out)) { console.error(`${opts.out} already exists; choose a new file name.`); return 1; }
  const report = pack.verify(target, { keep: true });
  if (report.errors.length) {
    for (const e of report.errors) console.error(`  error    ${e}`);
    return 1;
  }
  const commentary = pack.join(report.metadata, report.parts);
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(commentary) + '\n', { flag: 'wx' });
  console.log(`${opts.out}: ${commentary.entries.length} entries from ${report.parts.length} parts.`);
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'convert') {
    const result = spawnSync(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'scripts', 'convert.py'), ...rest], { stdio: 'inherit' });
    if (result.error) { console.error('Conversion needs Python 3.10 or newer: ' + result.error.message); return 1; }
    return result.status ?? 1;
  }
  const opts = args(rest);
  if (command === 'lint') return cmdLint(opts);
  if (command === 'new') return cmdNew(opts);
  if (command === 'info') return cmdInfo(opts);
  if (command === 'pack') return cmdPack(opts);
  if (command === 'unpack') return cmdUnpack(opts);
  console.log(USAGE);
  return command === 'help' || command === '--help' || command === undefined ? 0 : 2;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
