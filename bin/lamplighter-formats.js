#!/usr/bin/env node
'use strict';
// lamplighter-formats: lint, start and describe the JSON files Lamplighter reads.
const fs = require('node:fs');
const path = require('node:path');
const { lint, detectKind } = require('../lib/validate');
const { newEdition } = require('../lib/skeleton');

const USAGE = `lamplighter-formats <command> [options]

  lint <file…> [--json]        Read each file as the app does and report errors and warnings.
  new "<name>" --out FILE      Start an edition: every book, chapter and verse in place, texts empty.
      [--abbreviation ABBR] [--language eng] [--language-name English]
      [--license "Public Domain"] [--license-url URL] [--rtl] [--books all|ot|nt|"Genesis,John"]
  info <file>                  Counts and facts about a file.

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
  const text = raw.toString('utf8');
  if (text.includes('�')) throw new Error('the file is not valid UTF-8');
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`not valid JSON (${error.message})`); }
  return { data, bom };
}

function cmdLint(opts) {
  if (!opts._.length) { console.error(USAGE); return 2; }
  let failed = false;
  const reports = [];
  for (const file of opts._) {
    let report;
    try {
      const { data, bom } = read(file);
      report = lint(data);
      if (bom) report.warnings.unshift('The file starts with a byte-order mark; plain UTF-8 without it is safer.');
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
  const { data } = read(file);
  const report = lint(data);
  console.log(JSON.stringify({ file, kind: detectKind(data), ...report.info, errors: report.errors.length, warnings: report.warnings.length }, null, 2));
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  const opts = args(rest);
  if (command === 'lint') return cmdLint(opts);
  if (command === 'new') return cmdNew(opts);
  if (command === 'info') return cmdInfo(opts);
  console.log(USAGE);
  return command === 'help' || command === '--help' || command === undefined ? 0 : 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
