/* Word links: tie each word of a Bible verse to the Hebrew or Greek word it translates.
   Words an edition tags with Strong's numbers link as tagged. Other words are projected: a word must
   be a word of an original word's gloss (a translation already linked word by word) or a known
   rendering of its Strong's number, and it loses score with its distance from where the gloss
   translation puts that word in the verse.
   Loads as a CommonJS module or as a browser script (window.WordLinks). */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WordLinks = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var TOKENIZER = 'lamplighter-words-1';
  // A word is a run of letters, marks and digits, with apostrophes inside it (Lord's, don’t)
  var WORD = '[\\p{L}\\p{M}\\p{N}]+(?:[\'’][\\p{L}\\p{M}\\p{N}]+)*';
  // Words that only join the word they introduce
  var SMALL = {
    en: ('a an the of to in on at by for with from into unto upon and or but nor as that which who whom whose this these those it its is are was were be been being am '
      + 'he him his she her they them their we us our you your ye thee thou thy thine i me my mine not no shall will should would may might can could must have has had hath do does did doth '
      + 'there then so also up out if than when what where how why all every any some one let').split(' ')
  };
  var DISTANCE = 0.9; // score lost across the whole verse
  var FLOOR = 0.1;    // weaker candidates stay unlinked

  function tokenize(text) {
    var re = new RegExp(WORD, 'gu'), out = [], m;
    while ((m = re.exec(String(text || '')))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  function smallWords(language) {
    var list = SMALL[language || 'en'] || [];
    var set = Object.create(null);
    list.forEach(function (w) { set[w] = true; });
    return set;
  }

  // English: loved, loves and love meet at "lov"; createth and created at "creat"; short words stay whole.
  // Other languages compare whole lower-case words until they have rules of their own.
  function stem(word, language) {
    var w = String(word).toLowerCase();
    if (language && language !== 'en') return w;
    w = w.replace(/['’]s$/, '').replace(/['’]$/, '');
    if (w.length <= 3) return w;
    if (/ie[sd]$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
    var endings = ['eth', 'est', 'ing', 'edst', 'ed', 'es', 's', 'ly'];
    for (var i = 0; i < endings.length; i++) {
      var e = endings[i];
      if (w.length - e.length >= 3 && w.slice(-e.length) === e && !(e === 's' && /ss$/.test(w))) {
        w = w.slice(0, -e.length);
        break;
      }
    }
    if (/([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && w.charAt(w.length - 1) === 'e') w = w.slice(0, -1);
    return w;
  }

  // How often each word renders each Strong's number: { "H7225": { "beginning": 51 } }.
  // Each number's stems are counted on first use.
  function Renderings(table, language) {
    this.table = table || {};
    this.language = language || 'en';
    this.cache = Object.create(null);
  }
  Renderings.prototype.entry = function (strongs) {
    var found = this.cache[strongs];
    if (found) return found;
    var counts = Object.create(null), max = 0, words = this.table[strongs] || {}, language = this.language;
    Object.keys(words).forEach(function (w) {
      var s = stem(w, language);
      counts[s] = (counts[s] || 0) + words[w];
      if (counts[s] > max) max = counts[s];
    });
    return (this.cache[strongs] = { counts: counts, max: max });
  };
  Renderings.prototype.count = function (strongs, s) { return this.entry(strongs).counts[s] || 0; };
  Renderings.prototype.ratio = function (strongs, s) {
    var e = this.entry(strongs);
    return e.max ? (e.counts[s] || 0) / e.max : 0;
  };

  // A gloss's words; words in [brackets] were supplied by the translator. "" and "…" have none of their own.
  function glossWords(gloss) {
    var out = [], depth = 0;
    String(gloss || '').split(/([[\]])/).forEach(function (part) {
      if (part === '[') depth++;
      else if (part === ']') depth = Math.max(0, depth - 1);
      else tokenize(part).forEach(function (t) { out.push({ text: t.text, supplied: depth > 0 }); });
    });
    return out;
  }

  // Original word positions in the gloss translation's order
  function glossOrder(original) {
    var order = original.map(function (w, i) { return i; });
    return order.sort(function (a, b) {
      var x = original[a].glossOrder, y = original[b].glossOrder;
      return (x == null ? a : x) - (y == null ? b : y) || a - b;
    });
  }

  // The original words as the gloss translation orders them, each with where its gloss sits in that translation
  function pivot(original, language) {
    var small = smallWords(language);
    var order = glossOrder(original);
    var glosses = order.map(function (i) { return glossWords(original[i].gloss); });
    var total = glosses.reduce(function (n, g) { return n + g.length; }, 0) || 1;
    var at = 0;
    return order.map(function (i, k) {
      var g = glosses[k];
      var pos = g.length ? (at + g.length / 2) / total : at / total;
      at += g.length;
      var stems = Object.create(null), lower = Object.create(null), content = 0, fn = 0;
      g.forEach(function (w) {
        var l = w.text.toLowerCase();
        stems[stem(w.text, language)] = true;
        lower[l] = true;
        if (small[l]) fn++; else content++;
      });
      return { index: i, strongs: original[i].strongs || null, pos: pos, stems: stems, lower: lower, content: content, fn: fn };
    });
  }

  // For each word, the index of the original word it comes from, or -1
  function project(words, original, renderings, language) {
    language = language || 'en';
    var small = smallWords(language);
    var piv = pivot(original, language);
    var n = words.length || 1;
    var E = words.map(function (w, i) {
      var text = typeof w === 'string' ? w : w.text, lw = text.toLowerCase();
      return { lw: lw, st: stem(text, language), fn: !!small[lw], pos: (i + 0.5) / n };
    });
    var cands = [];
    E.forEach(function (e, ei) {
      piv.forEach(function (o, oi) {
        if (!o.strongs) return;
        var s = 0;
        if (o.stems[e.st]) s = e.fn ? 0.75 : 1;
        else if (renderings) {
          var r = renderings.ratio(o.strongs, e.st), c = renderings.count(o.strongs, e.st);
          if (e.fn ? r >= 0.25 : (r >= 0.02 || c >= 3)) s = (e.fn ? 0.35 : 0.5) + 0.4 * Math.sqrt(r);
        }
        if (!s) return;
        s -= DISTANCE * Math.abs(e.pos - o.pos);
        if (s > FLOOR) cands.push([s, ei, oi]);
      });
    });
    cands.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1] || a[2] - b[2]; });
    var link = E.map(function () { return -1; });
    var used = piv.map(function () { return { content: 0, fn: 0 }; });
    cands.forEach(function (c) {
      var ei = c[1], oi = c[2], e = E[ei], o = piv[oi], u = used[oi];
      if (link[ei] !== -1) return;
      if (e.fn ? u.fn >= o.fn + 1 : u.content >= Math.max(1, o.content) + 1) return;
      link[ei] = oi;
      if (e.fn) u.fn++; else u.content++;
    });
    // A small word joins the word it introduces when the gloss renders them together ("the" + "earth")
    for (var i = 0; i < E.length; i++) {
      if (link[i] !== -1 || !E[i].fn) continue;
      var near = [i + 1, i + 2, i - 1];
      for (var k = 0; k < near.length; k++) {
        var j = near[k];
        if (j < 0 || j >= E.length || link[j] === -1) continue;
        if (piv[link[j]].lower[E[i].lw]) { link[i] = link[j]; break; }
      }
    }
    return link.map(function (oi) { return oi === -1 ? -1 : piv[oi].index; });
  }

  // Tags for a verse of the edition the glosses come from: its words matched in order to the glosses'
  // words (the longest common sequence, ignoring case). A word in a gloss's [brackets] is supplied.
  function glossTags(words, original) {
    var same = function (w) { return String(typeof w === 'string' ? w : w.text).toLowerCase().replace(/’/g, "'"); };
    var source = [];
    glossOrder(original).forEach(function (i) {
      glossWords(original[i].gloss).forEach(function (g) { source.push({ text: same(g.text), supplied: g.supplied, index: i }); });
    });
    var mine = words.map(same), n = source.length, m = mine.length, width = m + 1;
    var table = new Uint16Array((n + 1) * width);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i * width + j] = source[i].text === mine[j] ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    var tags = [];
    for (var a = 0, b = 0; a < n && b < m;) {
      if (source[a].text === mine[b]) {
        var s = source[a], strongs = original[s.index].strongs;
        if (s.supplied) tags.push([b, '']);
        else if (strongs) tags.push([b, strongs, s.index]);
        a++; b++;
      } else if (table[(a + 1) * width + b] >= table[a * width + b + 1]) a++;
      else b++;
    }
    return tags;
  }

  // One verse's words from an original-language file as objects. A file with "wordFields" stores each
  // word as an array of those fields, in that order, to keep large files small.
  function originalWords(file, key) {
    var verse = file && file.verses && file.verses[key];
    if (!verse) return [];
    var fields = file.wordFields;
    if (!fields) return verse;
    return verse.map(function (row) {
      var word = {};
      fields.forEach(function (field, i) { if (row[i] !== undefined && row[i] !== null) word[field] = row[i]; });
      return word;
    });
  }

  // One verse: tagged words as tagged, the rest projected.
  // tags: [[wordIndex, "H853 H776", originalIndex?], ...] from a word-links file.
  // Returns one entry per word, or null when it has no link:
  // { original: index or -1, strongs: [...], tagged: bool, supplied: bool (tagged with no number: added in translation) }
  function linkVerse(words, original, options) {
    options = options || {};
    original = original || [];
    var language = options.language || 'en';
    var projected = project(words, original, options.renderings, language);
    var out = projected.map(function (oi) {
      return oi === -1 ? null : { original: oi, strongs: original[oi].strongs ? [original[oi].strongs] : [], tagged: false, supplied: false };
    });
    if (!options.tags || !options.tags.length) return out;
    var piv = pivot(original, language), n = words.length || 1;
    var posOf = Object.create(null);
    piv.forEach(function (o) { posOf[o.index] = o.pos; });
    options.tags.forEach(function (tag) {
      var wi = tag[0];
      if (!(wi >= 0 && wi < words.length)) return;
      var strongs = String(tag[1] || '').split(/\s+/).filter(Boolean);
      var oi = typeof tag[2] === 'number' && original[tag[2]] ? tag[2] : -1;
      if (oi === -1) {
        // The nearest original word carrying one of the tagged numbers
        var best = Infinity, pos = (wi + 0.5) / n;
        original.forEach(function (w, i) {
          if (strongs.indexOf(w.strongs) === -1) return;
          var d = Math.abs((posOf[i] == null ? i / original.length : posOf[i]) - pos);
          if (d < best) { best = d; oi = i; }
        });
      }
      out[wi] = { original: oi, strongs: strongs, tagged: true, supplied: !strongs.length };
    });
    return out;
  }

  return {
    tokenizer: TOKENIZER,
    tokenize: tokenize,
    stem: stem,
    Renderings: Renderings,
    glossWords: glossWords,
    glossTags: glossTags,
    originalWords: originalWords,
    project: project,
    linkVerse: linkVerse
  };
}));
