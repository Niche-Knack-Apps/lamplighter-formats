'use strict';
// A new edition, ready to be filled: every book, chapter and verse of the chosen canon in
// place, each verse with an empty text. Fill the texts, lint, and the app reads it.
const { canon } = require('./validate');

const NT_START = 39; // Matthew

function newEdition({ name, abbreviation = '', language = '', languageEnglishName = '', license = '', licenseUrl = '', textDirection = 'ltr', books = 'all' } = {}) {
  if (!name || !String(name).trim()) throw new Error('An edition needs a name.');
  let chosen = canon.books;
  if (books === 'ot') chosen = canon.books.slice(0, NT_START);
  else if (books === 'nt') chosen = canon.books.slice(NT_START);
  else if (Array.isArray(books)) {
    chosen = books.map(wanted => {
      const found = canon.books.find(b => b.name.toLowerCase() === String(wanted).toLowerCase() || b.abbrev.toLowerCase() === String(wanted).toLowerCase());
      if (!found) throw new Error(`"${wanted}" is not a book in the usual canon; add it by hand after the skeleton is made.`);
      return found;
    });
  } else if (books !== 'all') throw new Error('books: "all", "ot", "nt" or a list of book names.');
  return {
    name: String(name).trim(),
    abbreviation,
    language,
    languageEnglishName,
    license,
    license_url: licenseUrl,
    attribution: '',
    textDirection,
    books: chosen.map(b => ({
      name: b.name,
      abbrev: b.abbrev,
      chapters: b.chapters.map((count, c) => ({ chapter: c + 1, verses: Array.from({ length: count }, (_, v) => ({ verse: v + 1, text: '' })) }))
    }))
  };
}

module.exports = { newEdition };
