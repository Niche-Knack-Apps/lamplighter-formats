/**
 * BibleModel - Handles Bible data structure and provides lookup methods
 * Mirrors the Python Bible class from clible
 */
class BibleModel {
  constructor(data) {
    if (!data || !data.books) {
      throw new Error('Invalid Bible data: missing books array');
    }

    this.books = [];
    this.abbrevs = [];
    this.chapters = [];
    this.bookToIndex = new Map();

    // Parse the JSON structure
    data.books.forEach((book, index) => {
      const name = book.name || book.book || '';
      const abbr = book.abbr || book.abbrev || '';

      this.books.push(name);
      this.abbrevs.push(abbr);

      // Parse chapters and verses
      const chapters = [];
      (book.chapters || []).forEach(chapter => {
        const verses = (chapter.verses || []).map(v => v.text || '');
        chapters.push(verses);
      });
      this.chapters.push(chapters);

      // Build lookup index
      this.bookToIndex.set(this._normalize(name), index);
      if (abbr) {
        this.bookToIndex.set(this._normalize(abbr), index);
      }

      // Handle numbered books (e.g., "1 Samuel" -> "1samuel")
      const match = name.match(/^(\d+)\s+(.*)$/);
      if (match) {
        const [, num, rest] = match;
        this.bookToIndex.set(this._normalize(num + rest), index);
        const firstWord = rest.split(/\s+/)[0];
        this.bookToIndex.set(this._normalize(num + ' ' + firstWord), index);
      }
    });
  }

  /**
   * Normalize string for book name lookup
   */
  _normalize(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Find book index by name or abbreviation
   */
  findBook(query) {
    if (!query) return null;

    const key = this._normalize(query);

    // Exact match
    if (this.bookToIndex.has(key)) {
      return this.bookToIndex.get(key);
    }

    // Prefix matching
    for (let i = 0; i < this.books.length; i++) {
      if (this._normalize(this.books[i]).startsWith(key)) {
        return i;
      }
      if (this.abbrevs[i] && this._normalize(this.abbrevs[i]).startsWith(key)) {
        return i;
      }
    }

    return null;
  }

  /**
   * Get maximum chapter number for a book
   */
  maxChapter(bookIndex) {
    if (bookIndex < 0 || bookIndex >= this.chapters.length) {
      return 0;
    }
    return this.chapters[bookIndex].length;
  }

  /**
   * Get maximum verse number for a chapter
   */
  maxVerse(bookIndex, chapterIndex) {
    if (bookIndex < 0 || bookIndex >= this.chapters.length) {
      return 0;
    }
    if (chapterIndex < 0 || chapterIndex >= this.chapters[bookIndex].length) {
      return 0;
    }
    return this.chapters[bookIndex][chapterIndex].length;
  }

  /**
   * Get verse text by indices
   */
  getVerse(bookIndex, chapterIndex, verseIndex) {
    try {
      return this.chapters[bookIndex][chapterIndex][verseIndex];
    } catch (e) {
      return '';
    }
  }

  /**
   * Get all verses in a chapter
   */
  getChapter(bookIndex, chapterIndex) {
    try {
      return this.chapters[bookIndex][chapterIndex];
    } catch (e) {
      return [];
    }
  }

  /**
   * Parse reference string like "John 3:16" or "1 Samuel 17:45"
   * Returns { bookIndex, chapterIndex, verseIndex } or null
   */
  parseReference(ref) {
    if (!ref) return null;

    // Pattern: Book Chapter:Verse or Book Chapter
    const match = ref.match(/^(.+?)\s+(\d+)(?::(\d+))?$/);
    if (!match) return null;

    const [, bookName, chapter, verse] = match;
    const bookIndex = this.findBook(bookName.trim());

    if (bookIndex === null) return null;

    const chapterIndex = parseInt(chapter) - 1;
    const verseIndex = verse ? parseInt(verse) - 1 : 0;

    // Validate indices
    if (chapterIndex < 0 || chapterIndex >= this.maxChapter(bookIndex)) {
      return null;
    }

    if (verseIndex < 0 || verseIndex >= this.maxVerse(bookIndex, chapterIndex)) {
      return null;
    }

    return { bookIndex, chapterIndex, verseIndex };
  }

  /**
   * Search for term across all Bible text
   * Returns array of { bookIndex, chapterIndex, verseIndex, text, reference }
   */
  search(term) {
    if (!term) return [];

    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const results = [];

    this.chapters.forEach((book, bookIndex) => {
      book.forEach((chapter, chapterIndex) => {
        chapter.forEach((verse, verseIndex) => {
          if (regex.test(verse)) {
            results.push({
              bookIndex,
              chapterIndex,
              verseIndex,
              text: verse,
              reference: `${this.books[bookIndex]} ${chapterIndex + 1}:${verseIndex + 1}`
            });
          }
        });
      });
    });

    return results;
  }

  /**
   * Get formatted reference string
   */
  getReference(bookIndex, chapterIndex, verseIndex = null) {
    const book = this.books[bookIndex] || '';
    const chapter = chapterIndex + 1;
    const verse = verseIndex !== null ? verseIndex + 1 : '';

    return verse ? `${book} ${chapter}:${verse}` : `${book} ${chapter}`;
  }

  /**
   * Inject a single chapter's verses into the model after construction
   * Used for on-demand online chapter loading
   */
  injectChapter(bookIndex, chapterIndex, versesArray) {
    if (bookIndex < 0 || bookIndex >= this.chapters.length) return;
    // Extend chapters array if needed
    while (this.chapters[bookIndex].length <= chapterIndex) {
      this.chapters[bookIndex].push([]);
    }
    this.chapters[bookIndex][chapterIndex] = versesArray;
  }

  /**
   * Create a scaffold BibleModel with book metadata but empty chapters
   * Used for online versions where chapters are fetched on-demand
   */
  static fromScaffold(booksMetadata) {
    const data = {
      books: booksMetadata.map(b => ({
        name: b.name,
        abbrev: b.id || b.abbrev || '',
        chapters: Array.from({ length: b.chapterCount || 0 }, () => ({ verses: [] }))
      }))
    };
    const model = new BibleModel(data);
    model._isScaffold = true;
    return model;
  }

  /**
   * Check if a chapter has been loaded (has verses)
   */
  isChapterLoaded(bookIndex, chapterIndex) {
    if (bookIndex < 0 || bookIndex >= this.chapters.length) return false;
    if (chapterIndex < 0 || chapterIndex >= this.chapters[bookIndex].length) return false;
    return this.chapters[bookIndex][chapterIndex].length > 0;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BibleModel;
}
