/* Versification: move verse references between numbering schemes and recognize an edition's scheme.
   The tables are SIL's (data/versification, MIT); lib/versification-data.js is generated from them.
   Loads as a CommonJS module or as a browser script (window.Versification). */
(function (root, factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var api = factory(node ? require('./versification-data.js') : root.VERSIFICATION_DATA);
  if (node) module.exports = api;
  else root.Versification = api;
}(typeof window !== 'undefined' ? window : this, function (data) {
  'use strict';

  var ORDER = ['eng', 'org', 'vul']; // ties go to the earlier scheme
  var LINE = /^([0-9A-Z]{3}) (\d+):(\d+)(?:-(\d+))?=([0-9A-Z]{3}) (\d+):(\d+)(?:-(\d+))?$/;
  // Names editions and modules declare (SWORD, Paratext, common usage) for the schemes covered here
  var NAMES = {
    eng: ['eng', 'english', 'kjv', 'kjva', 'rsv', 'nrsv', 'nrsva'],
    org: ['org', 'original', 'hebrew', 'bhs', 'mt', 'leningrad'],
    vul: ['vul', 'vulg', 'vulgate']
  };
  var tables = {};

  function key(ref) { return ref.b + ' ' + ref.c + ':' + ref.v; }
  function same(a) { return function (b) { return a.b === b.b && a.c === b.c && a.v === b.v; }; }

  function expand(b, c, first, last) {
    var out = [];
    for (var v = first; v <= last; v++) out.push({ b: b, c: c, v: v });
    return out;
  }

  // Equal ranges pair verse by verse; a single verse on either side pairs with every verse on the other.
  function pairs(from, to) {
    if (from.length === 1) return to.map(function (ref) { return [from[0], ref]; });
    if (to.length === 1) return from.map(function (ref) { return [ref, to[0]]; });
    return from.map(function (ref, i) { return [ref, to[Math.min(i, to.length - 1)]]; });
  }

  function add(table, from, to) {
    var list = table.get(key(from));
    if (!list) table.set(key(from), list = []);
    if (!list.some(same(to))) list.push(to);
  }

  // Each scheme's table is built the first time a lookup needs it
  function table(scheme) {
    if (!data.schemes[scheme]) return null;
    if (tables[scheme]) return tables[scheme];
    var forward = new Map(), reverse = new Map(), books = new Set();
    data.schemes[scheme].toOriginal.forEach(function (line) {
      var m = LINE.exec(line);
      var from = expand(m[1], +m[2], +m[3], +(m[4] || m[3]));
      var to = expand(m[5], +m[6], +m[7], +(m[8] || m[7]));
      books.add(m[1]);
      books.add(m[5]);
      pairs(from, to).forEach(function (pair) { add(forward, pair[0], pair[1]); add(reverse, pair[1], pair[0]); });
    });
    return (tables[scheme] = { forward: forward, reverse: reverse, books: books });
  }

  // References not listed in a table have the same number in both schemes.
  function lookup(table, ref) { return table.get(key(ref)) || [ref]; }

  /**
   * Map { b: USFM book ID, c: chapter, v: verse } from one scheme to another. Verse 0 is a psalm title.
   * Returns every corresponding reference; an unknown scheme on either side leaves the numbers as they are.
   */
  function map(ref, from, to) {
    if (from === to || !data.schemes[from] || !data.schemes[to]) return [ref];
    var original = from === 'org' ? [ref] : lookup(table(from).forward, ref);
    if (to === 'org') return original.slice();
    var out = [];
    original.forEach(function (r) {
      lookup(table(to).reverse, r).forEach(function (x) { if (!out.some(same(x))) out.push(x); });
    });
    return out;
  }

  /** True when some scheme numbers this book differently from the others */
  function differs(bookId) {
    return ORDER.some(function (scheme) { return table(scheme).books.has(bookId); });
  }

  /** Scheme ID for a declared versification name, or null when these tables don't cover it */
  function normalize(name) {
    var value = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (var scheme in NAMES) if (NAMES[scheme].indexOf(value) >= 0) return scheme;
    return null;
  }

  /**
   * Recognize a scheme from an edition's own counts. countsFor(bookId) returns its verse counts per
   * chapter (index 0 is chapter 1), or null when the edition lacks the book; a 0 count is skipped.
   * Returns { scheme, evidence, score }: scheme is null when no scheme matches at least half the evidence,
   * and English when there is no evidence at all.
   */
  function detect(countsFor) {
    var score = {}, evidence = 0;
    ORDER.forEach(function (scheme) { score[scheme] = 0; });
    data.fingerprint.forEach(function (item) {
      var counts = countsFor(item[0]);
      if (!counts || !counts.length) return;
      var value = item[1] === 0 ? counts.length : counts[item[1] - 1];
      if (!value) return;
      evidence++;
      ORDER.forEach(function (scheme) { if (item[2][scheme] === value) score[scheme]++; });
    });
    if (!evidence) return { scheme: 'eng', evidence: 0, score: score };
    var best = ORDER.reduce(function (a, b) { return score[b] > score[a] ? b : a; });
    return { scheme: score[best] * 2 >= evidence ? best : null, evidence: evidence, score: score };
  }

  return { schemes: ORDER.slice(), source: data.source, map: map, differs: differs, normalize: normalize, detect: detect };
}));
