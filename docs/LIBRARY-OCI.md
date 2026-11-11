# The Lamplighter study library on OCI registries — spec v1

The contract between a publisher (`scripts/oci-library.py`, or anyone running their own registry) and
the Lamplighter app. Everything in it is additive to what Lamplighter 1.6.20 and later read, so an
older app sees only the Bibles in a library index.

Fixtures: `tests/fixtures/oci-library/`, pinned by `tests/oci-library.test.js` here and by the app's
own tests.

## 1. Layout

A source is `oci://host/prefix` (`https://` the same; `http://` for a registry on the LAN).

| Repository | Holds |
|---|---|
| `<prefix>/index` | the index, tag `latest` |
| `<prefix>/editions/<id>` | a Bible edition (unchanged since 1.6.20) |
| `<prefix>/commentaries/<id>` | a commentary |
| `<prefix>/confessions/<id>` | a confession, creed or catechism |
| `<prefix>/study/<id>` | a study work: cross-references, a topical index, a dictionary |

- Works are tagged with their packaging version (`1.0.0`, `1.1.0`); editions keep `main.r<revision>`.
- The index entry's `manifestDigest` is what the app pulls by; tags are for people and `oras`.

## 2. Media types

| | Media type |
|---|---|
| index artifact | `application/vnd.nicheknack.lamplighter.index.v1` (unchanged) |
| index entries layer | `application/vnd.nicheknack.lamplighter.index.v1+json` (unchanged) |
| index signature layer | `application/vnd.nicheknack.lamplighter.index.signature.v1+json` (new) |
| work artifact | `application/vnd.nicheknack.lamplighter.<kind>.v1` |
| work config | `application/vnd.nicheknack.lamplighter.<kind>.config.v1+json` |
| work layer | `application/vnd.nicheknack.lamplighter.<kind>.v1+json`, or `…v1+json+gzip` |

- `<kind>` is `edition`, `commentary`, `confession` or `study`.
- Manifests are `application/vnd.oci.image.manifest.v1+json` with `artifactType` set; the index's config
  is the OCI empty config.
- The work config is the work's own index entry (§3) without `repo`, `tag`, `manifestDigest` and `size`.
- The work layer is the file exactly as the app imports it (the lamplighter-formats pack for its kind),
  gzip-compressed or not. Its digest is over the bytes as stored.

## 3. The index

```json
{
  "schema": 1,
  "generated": "2026-11-11T00:00:00Z",
  "publisher": "Niche-Knack Apps",
  "definitions": { "reformed": { "name": "Reformed", "definition": "Salvation is God's work …" } },
  "entries": [ { "id": "matthew-henry", "kind": "commentary", "…": "…" } ]
}
```

- `schema` stays 1: every field below is additive. A reader ignores fields it doesn't know.
- `generated` only grows from one publish to the next (§5 rollback).
- `definitions`: one per label used in the index — `name` (shown) and `definition` (≤ 400 characters).
  Labels: `reformed`, `arminian`, `antinomian`, `lutheran`, `catholic`, `heretical` (shown as
  "Traditional heretical"), `neutral`, `mixed` (shown as "Per author").

### Entry fields

| Field | Kinds | Notes |
|---|---|---|
| `id` | all | `[a-z0-9._-]`, unique across the whole index (not per kind) |
| `kind` | all | missing = `edition`; a kind the app doesn't know is ignored |
| `repo`, `tag`, `manifestDigest`, `size` | all | `size` = layer bytes as stored |
| `name` | all | the display title (editions have always used `name`) |
| `language`, `languageEnglishName` | all | ISO 639-3 and its English name |
| `license`, `licenseUrl`, `attribution` | all | as editions |
| `revision` | edition | as today |
| `bookCount`, `textDirection` | edition | as today |
| `version` | work | the packaging version, = the tag |
| `author` | work | "Matthew Henry" |
| `date` | work | free text: "1708–1710", "1646", "c. 1880" |
| `coverage` | work | "Whole Bible", "Gospels and Acts", "33 chapters" |
| `description` | work | plain text, ≤ 400 characters, two or three lines |
| `sourceUrl` | work | where the text was taken from |
| `stance` | work | `{ "label": "<label>", "why": "≤ 300 characters" }` |
| `stanceAlso` | work | further labels a collection also carries, e.g. `["heretical"]` |
| `studyType` | study | `cross-references`, `topical` or `dictionary` |
| `format` | work | the pack format of the layer, e.g. `lamplighter-commentary@1` |
| `compressed` | work | `true` when the layer is `+gzip` |

A work entry needs `id`, `kind`, `repo`, `tag`, `manifestDigest`, `size`, `name`, `language`, `license`,
`version`, `format` and `stance`; the rest are shown when present.

## 4. Signature

The index manifest may carry a second layer, the signature:

```json
{ "alg": "ed25519", "keyId": "<16 hex>", "signed": "sha256:<entries layer digest>", "signature": "<base64url>" }
```

- Message: the UTF-8 bytes of `lamplighter-library-index-v1\n` + the entries layer's digest + `\n`.
  The digest pins every byte of the entries, so the signature covers them.
- `keyId`: the first 16 hex characters of SHA-256 of the 32-byte raw public key.
- Verification, in order:
  1. The entries layer matches its digest (as today).
  2. `signed` equals that digest.
  3. `keyId` names a key the app carries.
  4. Ed25519 verifies strictly (RFC 8032; `zip215: false`).
- Where it lives in the layer list doesn't matter. Apps since 1.6.20 and `oci-editions.py` find the
  entries layer by its media type, so the extra layer is invisible to them.
- The key is a dedicated Ed25519 key, the "Lamplighter library key", not the OpenPGP key that signs
  commits; verifying OpenPGP in the reader would need a packet parser.
  - The first key, `8f57a68d449d468f`, was minted 2026-11-11 with `oci-library.py keygen` and is kept
    offline by Niche-Knack Apps. Its public half is `library/library-keys.json`, which
    `oci-library.py catalog` checks against.
  - The app carries a list of public keys. A new key ships in an update before anything is signed
    with it.

## 5. Trust, as the app shows it

- **nk.tools** (built in): the index must verify. If it doesn't (unsigned, bad signature, unknown
  key), the app keeps the last verified copy and says the library couldn't be checked.
- **A registry you add**: a signature is optional.
  - Signed with a key the app carries (a mirror of the nk.tools library on a church's own registry):
    shown as the Niche-Knack library.
  - Otherwise: "added by you", and its labels show as "labels from <registry>".
- **Rollback**: per source, the app keeps the highest `generated` it has accepted, and refuses an index
  older than that.
- **Works**: every blob is checked against its digest. A work's manifest must have the artifact type
  for its entry's `kind`.

## 6. Search (on the device)

- Refresh fetches each source's `index:latest` manifest. When the entries digest is the one already
  cached, nothing more is fetched.
- Search runs over the cached indexes of every source that is on, offline. It matches `name`,
  `author`, `description`, the label's name, `coverage` and `languageEnglishName`.
- Filters: kind, label, language, source.

## 7. Static tree

`oci-library.py export-static` writes a read-only tree any web server can serve under `/v2/`.
nk.tools serves the Niche-Knack library this way, as `oci://nk.tools/lamplighter`.

| Path | File |
|---|---|
| `/v2/` | `{}` |
| `/v2/<repo>/manifests/<tag>` and `/v2/<repo>/manifests/sha256:<hex>` | the same manifest bytes |
| `/v2/<repo>/blobs/sha256:<hex>` | the blob |
| `/v2/<repo>/tags/list` | `{"name":"<repo>","tags":[…]}` |

- Manifests are served as `application/vnd.oci.image.manifest.v1+json` with `Docker-Content-Digest`.
  Blobs are served as `application/octet-stream`.
- `Access-Control-Allow-Origin: *` on GET and HEAD, for the app's WebView origins.
- Anything named by digest never changes and can be cached for good; tags and `tags/list` cannot.
- Only GET and HEAD are allowed. `oras pull` and the app read it as a registry.

## 8. Limits (bounded on small phones)

| | Limit |
|---|---|
| index entries layer | 4 MiB, 10,000 entries |
| one work layer | 64 MiB as stored and 64 MiB unpacked: the most a device can share (the export's `RESOURCE_LIMIT`, the nearby wire's `RESOURCE.maxSize`) |
| description / why / definition | 400 / 300 / 400 characters |

Over a limit, the app refuses that index or work with a plain reason.

## 9. Where nothing happens

The app makes no index, search or download request while it is hidden, or with online sources off.

## 10. Compatibility rules

- Apps since 1.6.20 list only `kind: edition` (a missing kind counts as one), so new kinds are
  invisible to them. Pinned by the app's tests.
- `oci-editions.py push` into a library index keeps every entry of every kind, and the index's other
  top-level fields. It writes no signature, so a push to a signed library must go through
  `oci-library.py`. An unsigned nk.tools index is refused by the app, and the last verified one stays in use.
- The index only grows: a push refuses to drop entries unless told to.
- Every published work can be shared device to device: exported to an encrypted file, or sent over the
  nearby link, and imported on another device in the same format.
  - `oci-library.py publish` takes only formats the app can import, export and share:
    `lamplighter-commentary@1` today.
  - Confession and study formats publish only with `--draft-format`, to a staging registry. They go to
    nk.tools in the app release that imports, exports and shares them.
  - A work over the unpacked limit (§8) is refused at publish, so it never reaches a reader who cannot
    pass it on.
