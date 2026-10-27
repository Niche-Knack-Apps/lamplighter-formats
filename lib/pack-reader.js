/* Commentary packs, the reader's side: which part files a passage needs, found in the pack's
   _index.json without opening any part. Loads as a CommonJS module or as a browser script
   (window.CommentaryPack), so readers use exactly the lookup the tools test. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CommentaryPack = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var METADATA = '_metadata.json';
  var INDEX = '_index.json';

  // A chapter's reference to a part: the part number alone when any verse may need it,
  // [part, first] from that verse on, [part, first, last] for those verses only.
  function needed(ref, verses) {
    if (typeof ref === 'number') return true;
    if (!verses || !verses.length) return true;
    var last = ref.length > 2 ? ref[2] : Infinity;
    return verses.some(function (v) { return v >= ref[1] && v <= last; });
  }

  function listed(index, numbers) {
    return numbers.sort(function (a, b) { return a - b; }).map(function (n) { return index.parts[n]; });
  }

  /**
   * The parts holding notes on these verses of one chapter, in pack order.
   * bookIndex and chapter are in the commentary's own numbering; verses count from 1,
   * and leaving them out asks for the whole chapter. Notes on a whole book are separate:
   * see wholeBookParts.
   */
  function partsFor(index, bookIndex, chapter, verses) {
    var book = index.books[String(bookIndex)];
    var refs = book && book.chapters[String(chapter)];
    if (!refs) return [];
    var numbers = [];
    refs.forEach(function (ref) {
      var n = typeof ref === 'number' ? ref : ref[0];
      if (numbers.indexOf(n) < 0 && needed(ref, verses)) numbers.push(n);
    });
    return listed(index, numbers);
  }

  /** The parts holding notes on a book as a whole (introductions), in pack order. */
  function wholeBookParts(index, bookIndex) {
    var book = index.books[String(bookIndex)];
    return book && book.whole ? listed(index, book.whole.slice()) : [];
  }

  /** The book names the pack's notes use, as { book_index: [names] }, for matching books. */
  function bookNames(index) {
    var names = {};
    Object.keys(index.books).forEach(function (key) { names[key] = (index.books[key].names || []).slice(); });
    return names;
  }

  return { METADATA: METADATA, INDEX: INDEX, partsFor: partsFor, wholeBookParts: wholeBookParts, bookNames: bookNames };
}));
