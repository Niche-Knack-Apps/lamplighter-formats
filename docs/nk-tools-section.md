# nk.tools · Lamplighter · "Add a translation" section (copy for the website)

## Add a translation

> **Simple by design.** A Bible edition for Lamplighter is one plain JSON file: books, chapters,
> verses, text. It needs no proprietary file type, no special tooling, and no account.
> New languages for new people groups can be created and added easily.

Everything you need is in one public repository:
**[github.com/Niche-Knack-Apps/lamplighter-formats](https://github.com/Niche-Knack-Apps/lamplighter-formats)**

- **The formats**, each with a complete example: editions, commentaries, cross-references,
  original-language words, lexicons.
- **A linter** that reads a file exactly as the app does and says, in plain words, what is wrong.
- **Templates** and a **skeleton** command that starts a new edition with every book, chapter and
  verse in place, so a translation team only has to fill in the text.
- **A test** that loads a file through the app's own reader model, to prove it renders.
- **A publisher** that puts editions on any OCI registry (a zot server on your own hardware
  works), so the people you serve add one address in Settings and the editions are there.

Three steps: start a file, fill in the text, lint it. Read it on desktop from a folder, or
publish it to a registry and read it anywhere.
