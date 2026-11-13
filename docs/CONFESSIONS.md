# Statements and confessions

`lamplighter-confessions@1` preserves the Lamplighter reader's confession data.
An OCI `confession` artifact contains one complete work:

```json
{"format":"lamplighter-confessions@1","works":[{"id":"example","name":"Example statement","short":"Example","source":"Source and reproduction credit","chapters":[{"n":1,"title":"Faith","paragraphs":[{"n":1,"body":["Text.",["a",["John.3.16"]]]}]}]}]}
```

The artifact's entry ID equals the work ID. Each chapter and paragraph has a
unique numeric locator within its parent. A paragraph may have a `question`.
Body items are text, `[proofLabel, references]`, or `{label, refs}` for references
printed inline. Reference strings retain the reader's standard book locators.
Optional work fields are `year`, `unit`, `locator`, `numerals` and `sourceNotes`
(`{at, printed}`); chapter fields include `cite` and `label`.

The publisher validates these bounds and requires at least one chapter and
paragraph. The complete JSON must fit the existing 64 MiB sharing limit.
Lamplighter 1.11.138 adds signed online discovery, verified encrypted downloads,
reading of received copies, and encrypted content-file exports/imports using
the existing `resource` kind. Library packs and nearby resource transfer carry
the same JSON without dropping source credits, textual variants or proofs.
Earlier readers retain their bundled confessions and ignore this online format.
