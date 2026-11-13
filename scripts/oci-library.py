#!/usr/bin/env python3
"""Publish the Lamplighter study library (commentaries, confessions, study works) to an OCI registry.

    oci-library.py keygen        DIR
    oci-library.py publish       oci://registry/prefix WORKS.json [--key KEY.pem] [--keys KEYS.json]
    oci-library.py catalog       oci://registry/prefix [--keys KEYS.json] [--require-signed]
    oci-library.py pull          oci://registry/prefix ID [--out FILE] [--require-signed]
    oci-library.py export-static oci://registry/prefix DIR [--require-signed]

The contract is docs/LIBRARY-OCI.md in lamplighter-formats, where this script lives; the Lamplighter app
vendors a pinned copy. Editions are still pushed with oci-editions.py; this keeps their entries.
WORKS.json is {"publisher", "definitions": {label: {name, definition}},
"works": [{id, kind, file, version, name, author, …, stance: {label, why}}]}.

- Everything is checked before anything is sent: every work, every version already published, the
  labels, the index's size and its generated time.
- A version, once published, never changes: new content needs a new version. Content is compared
  unpacked, so a re-run on another Python or zlib build is still "unchanged".
- Every work is in a format the app exports and shares Lamplighter to Lamplighter (SHAREABLE), and
  within the 64 MiB a share carries. A format the app doesn't share yet is refused, except with
  --draft-format on a staging registry; export-static refuses it too.
- publish --key signs the index with the Lamplighter library key, which must be in the key list the app
  ships (library/library-keys.json here, internals/library/library-keys.json in the app). It refuses
  to sign entries no valid signature covered (unless --adopt-unverified), and to leave a signed index
  unsigned (unless --unsigned).

keygen writes the library key: library-ed25519.pem (private, 0600) and library-key.json (public).
export-static writes the read-only tree Caddy serves under /v2/ (spec §7). Signing and checking need
the cryptography package; the rest is standard library. Credentials as in oci-editions.py.
"""
import argparse
import base64
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import zlib

_spec = importlib.util.spec_from_file_location('oci_editions', Path(__file__).with_name('oci-editions.py'))
oci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(oci)

KINDS = {'commentary': 'commentaries', 'confession': 'confessions', 'study': 'study'}
# Formats the app imports, exports and shares Lamplighter to Lamplighter (encrypted file, library pack,
# nearby transfer). A confession or study format joins when the app release that shares it does.
SHAREABLE = {'lamplighter-commentary@1': 'commentary', 'lamplighter-confessions@1': 'confession'}
LABELS = ('reformed', 'arminian', 'antinomian', 'lutheran', 'catholic', 'heretical', 'neutral', 'mixed')
STUDY_TYPES = ('cross-references', 'topical', 'dictionary')
SIGNATURE_LAYER = 'application/vnd.nicheknack.lamplighter.index.signature.v1+json'
SIGNED_PREFIX = b'lamplighter-library-index-v1\n'
MAX_INDEX = 4 << 20
MAX_ENTRIES = 10000
MAX_MANIFEST = 4 << 20
MAX_CONFIG = 64 << 10
MAX_SIGNATURE = 4 << 10
MAX_STORED = 64 << 20
MAX_UNPACKED = 64 << 20  # what one share carries (the app's content-file.mjs RESOURCE_LIMIT, resource-wire.mjs)
MAX_COMMENTARY_ENTRIES = 250000  # what the app's resource store accepts
REQUIRED = ('id', 'kind', 'file', 'version', 'name', 'language', 'license', 'format', 'stance')
OPTIONAL = ('languageEnglishName', 'licenseUrl', 'attribution', 'author', 'date', 'coverage', 'description',
            'sourceUrl', 'stanceAlso', 'studyType')
TEXT = ('name', 'license', 'languageEnglishName', 'licenseUrl', 'attribution', 'author', 'date', 'coverage',
        'description', 'sourceUrl')
# The key list beside this script: library/ in lamplighter-formats, internals/library/ in the app
_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEYS = next((p for p in (_ROOT / 'library/library-keys.json', _ROOT / 'internals/library/library-keys.json') if p.exists()),
                    _ROOT / 'library/library-keys.json')
# The OCI distribution grammar for repository names and tags, and the only digest form the app pulls by
NAME = re.compile(r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*', re.ASCII)
TAG = re.compile(r'[A-Za-z0-9_][A-Za-z0-9._-]{0,127}', re.ASCII)
DIGEST = re.compile(r'sha256:[0-9a-f]{64}', re.ASCII)
STAMP = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', re.ASCII)


def fail(message):
    sys.exit(message)


def media(kind):
    base = f'application/vnd.nicheknack.lamplighter.{kind}'
    return {'artifact': f'{base}.v1', 'config': f'{base}.config.v1+json', 'layer': f'{base}.v1+json', 'gzip': f'{base}.v1+json+gzip'}


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def stamp(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def js_len(text):
    """Length as the app counts it (UTF-16 code units), so a limit here is the limit there"""
    return len(text.encode('utf-16-le')) // 2


def canonical(value):
    # The bytes oci-editions.py pushes manifests and indexes as, so digests computed here match
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode()


def gunzip(data, limit=MAX_UNPACKED):
    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = inflate.decompress(data, limit + 1)
    if len(out) > limit or inflate.unconsumed_tail:
        fail(f'a layer unpacks to more than {limit} bytes')
    if not inflate.eof or inflate.unused_data:
        fail('a layer is not one complete gzip stream')
    return out


# ----- the work checks (spec §3, §8) -----
def check_definitions(definitions):
    for label, definition in definitions.items():
        if label not in LABELS:
            fail(f'unknown label {label!r}; labels are {", ".join(LABELS)}')
        if not isinstance(definition, dict) or not isinstance(definition.get('name'), str) or not definition['name'] \
                or not isinstance(definition.get('definition'), str) or not 0 < js_len(definition['definition']) <= 400:
            fail(f'the definition of {label} needs a name and a definition of at most 400 characters')


def check_confessions(data, expected_id):
    """The bounded lamplighter-confessions@1 document the reader imports and shares."""
    def text(value, maximum, required=True):
        return isinstance(value, str) and js_len(value) <= maximum and (not required or bool(value.strip()))
    def number(value):
        return type(value) is int and 0 <= value <= 100000
    def need(condition):
        if not condition:
            fail(f'{expected_id}: invalid lamplighter-confessions@1 document')
    need(data.get('format') == 'lamplighter-confessions@1')
    works = data.get('works')
    need(isinstance(works, list) and len(works) == 1)
    work = works[0]
    need(isinstance(work, dict) and work.get('id') == expected_id)
    need(text(work.get('name'), 500) and text(work.get('short'), 100) and text(work.get('source'), 16000))
    for key in ('year', 'unit', 'locator'):
        if key in work:
            need(text(work[key], 100, False))
    if 'numerals' in work:
        need(type(work['numerals']) is bool)
    if 'sourceNotes' in work:
        notes = work['sourceNotes']
        need(isinstance(notes, list) and len(notes) <= 1000)
        need(all(isinstance(n, dict) and text(n.get('at'), 500) and text(n.get('printed'), 16000) for n in notes))
    chapters = work.get('chapters')
    need(isinstance(chapters, list) and 0 < len(chapters) <= 1000)
    seen, count = set(), 0
    for chapter in chapters:
        need(isinstance(chapter, dict) and number(chapter.get('n')) and chapter['n'] not in seen and text(chapter.get('title'), 2000))
        seen.add(chapter['n'])
        for key in ('cite', 'label'):
            if key in chapter:
                need(text(chapter[key], 500, False))
        paragraphs = chapter.get('paragraphs')
        need(isinstance(paragraphs, list) and len(paragraphs) > 0)
        count += len(paragraphs)
        need(count <= 20000)
        numbers = set()
        for paragraph in paragraphs:
            need(isinstance(paragraph, dict) and number(paragraph.get('n')) and paragraph['n'] not in numbers)
            numbers.add(paragraph['n'])
            if 'question' in paragraph:
                need(text(paragraph['question'], 16000))
            body = paragraph.get('body')
            need(isinstance(body, list) and 0 < len(body) <= 2000)
            for part in body:
                if isinstance(part, str):
                    need(text(part, 128000, False))
                    continue
                if isinstance(part, list):
                    need(len(part) == 2 and text(part[0], 100))
                    refs = part[1]
                else:
                    need(isinstance(part, dict) and text(part.get('label'), 16000))
                    refs = part.get('refs')
                need(isinstance(refs, list) and 0 < len(refs) <= 2000 and all(text(ref, 100) for ref in refs))


def check_work(work, definitions, base, draft_format):
    name = work.get('id', '?')
    unknown = set(work) - set(REQUIRED) - set(OPTIONAL)
    if unknown:
        fail(f'{name}: unknown field(s) {", ".join(sorted(unknown))}')
    for field in REQUIRED:
        if work.get(field) in (None, ''):
            fail(f'{name}: {field} is required')
    for field in TEXT + ('id', 'kind', 'file', 'version', 'language', 'format', 'studyType'):
        if field in work and not isinstance(work[field], str):
            fail(f'{name}: {field} is text')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', work['id'], re.ASCII):
        fail(f'{name}: an id is lowercase letters, digits, dot, dash and underscore')
    if work['kind'] not in KINDS:
        fail(f'{name}: kind is one of {", ".join(KINDS)} (editions go through oci-editions.py)')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', work['version'], re.ASCII):
        fail(f'{name}: version looks like 1.0.0')
    if not re.fullmatch(r'[a-z]{3}', work['language'], re.ASCII):
        fail(f'{name}: language is an ISO 639-3 code such as eng')
    if not re.fullmatch(r'lamplighter-[a-z-]+@[0-9]+', work['format'], re.ASCII):
        fail(f'{name}: format looks like lamplighter-commentary@1')
    if work['kind'] == 'commentary' and work['format'] != 'lamplighter-commentary@1':
        fail(f'{name}: a commentary is the app\'s commentary JSON, lamplighter-commentary@1')
    if SHAREABLE.get(work['format']) != work['kind'] and not draft_format:
        fail(f'{name}: {work["format"]} is not a format the app shares Lamplighter to Lamplighter yet; '
             'it joins the library with the app release that does (--draft-format for a staging registry only)')
    stance = work['stance']
    if not isinstance(stance, dict) or set(stance) - {'label', 'why'} or stance.get('label') not in definitions:
        fail(f'{name}: stance is {{label, why}} with a label the index defines')
    if not isinstance(stance.get('why'), str) or not 0 < js_len(stance['why']) <= 300:
        fail(f'{name}: stance.why is required, at most 300 characters')
    also = work.get('stanceAlso') or []
    if not isinstance(also, list) or any(label not in definitions for label in also):
        fail(f'{name}: stanceAlso lists labels the index defines')
    if js_len(work.get('description') or '') > 400:
        fail(f'{name}: description is at most 400 characters')
    if work['kind'] == 'study' and work.get('studyType') not in STUDY_TYPES:
        fail(f'{name}: a study work has a studyType: {", ".join(STUDY_TYPES)}')
    path = Path(work['file']) if os.path.isabs(work['file']) else base / work['file']
    raw = path.read_bytes()
    try:
        data = json.loads(raw)
    except ValueError:
        fail(f'{name}: {path} is not JSON')
    if not isinstance(data, dict):
        fail(f'{name}: {path} is not a JSON object')
    # The app shares the work as it stores it, re-serialized: both sizes must fit one share
    shared = len(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode())
    if max(len(raw), shared) > MAX_UNPACKED:
        fail(f'{name}: {max(len(raw), shared)} bytes is over the 64 MiB one Lamplighter-to-Lamplighter share carries')
    if work['kind'] == 'commentary':
        entries = data.get('entries')
        if data.get('type') != 'commentary' or not isinstance(data.get('name'), str) or not isinstance(entries, list) \
                or not 0 < len(entries) <= MAX_COMMENTARY_ENTRIES \
                or not all(isinstance(e, dict) and isinstance(e.get('range'), dict) and isinstance(e.get('content'), str) for e in entries):
            fail(f'{name}: {path} is not a commentary the app imports ({{type: commentary, name, entries[{{range, content}}]}})')
    stored = gzip.compress(raw, compresslevel=9, mtime=0)
    if len(stored) > MAX_STORED:
        fail(f'{name}: {len(stored)} bytes stored is over the 64 MiB limit')
    if work['format'] == 'lamplighter-confessions@1':
        check_confessions(data, work['id'])
    return raw, stored


def entry_facts(work):
    """The entry without repo, tag, manifestDigest and size: the work's config blob (spec §2)"""
    facts = {key: work[key] for key in REQUIRED + OPTIONAL if key != 'file' and work.get(key) not in (None, '', [])}
    facts.setdefault('languageEnglishName', 'English' if work['language'] == 'eng' else work['language'])
    for key in ('licenseUrl', 'attribution'):
        facts.setdefault(key, '')
    facts['compressed'] = True
    return facts


# ----- registry helpers -----
def raw_manifest(registry, repo, reference):
    status, headers, body = registry.request('GET', f'{repo}/manifests/{reference}', headers={'Accept': oci.MANIFEST}, limit=MAX_MANIFEST)
    if status == 404:
        return None, None
    if status != 200:
        fail(f'manifest fetch failed for {repo}:{reference}: {status} {body[:200]!r}')
    if len(body) > MAX_MANIFEST:
        fail(f'the manifest for {repo}:{reference} is over 4 MiB')
    digest = sha(body)
    sent = headers.get('Docker-Content-Digest') or headers.get('docker-content-digest')
    if (sent and sent != digest) or (reference.startswith('sha256:') and reference != digest):
        fail(f'the manifest for {repo}:{reference} did not match its digest')
    try:
        manifest = json.loads(body)
    except ValueError:
        fail(f'the manifest for {repo}:{reference} is not JSON')
    layers = manifest.get('layers') if isinstance(manifest, dict) else None
    if not isinstance(layers, list) or not all(isinstance(l, dict) and DIGEST.fullmatch(str(l.get('digest'))) for l in layers) \
            or (manifest.get('config') is not None and not (isinstance(manifest['config'], dict) and DIGEST.fullmatch(str(manifest['config'].get('digest'))))):
        fail(f'the manifest for {repo}:{reference} is not an OCI manifest this tool reads')
    return body, digest


def tags(registry, repo):
    status, _, body = registry.request('GET', f'{repo}/tags/list', limit=MAX_MANIFEST)
    if status == 404:
        return []
    if status != 200 or len(body) > MAX_MANIFEST:
        fail(f'tag list failed for {repo}: {status}')
    try:
        listed = json.loads(body)
    except ValueError:
        fail(f'tag list for {repo} is not JSON')
    listed = (listed.get('tags') if isinstance(listed, dict) else None) or []
    if not all(isinstance(t, str) and TAG.fullmatch(t) for t in listed):
        fail(f'{repo} lists a tag that is not a valid OCI tag')
    return sorted(listed)


def read_signed_index(registry):
    """(index, entries bytes, signature, manifest digest) as the registry holds them"""
    repo = registry.repo('index')
    body, digest = raw_manifest(registry, repo, 'latest')
    if body is None:
        return {'schema': 1, 'generated': '', 'publisher': '', 'definitions': {}, 'entries': []}, None, None, None
    layers = json.loads(body)['layers']
    entries_layer = next((l for l in layers if l.get('mediaType') == oci.INDEX_LAYER), None)
    if not entries_layer:
        fail('the registry\'s index has no entries layer')
    data = registry.blob(repo, entries_layer['digest'], limit=MAX_INDEX)
    try:
        index = json.loads(data)
    except ValueError:
        fail('the registry\'s index is not JSON')
    if not isinstance(index, dict) or not isinstance(index.get('entries', []), list) or len(index.get('entries', [])) > MAX_ENTRIES \
            or not isinstance(index.get('definitions', {}), dict):
        fail(f'the registry\'s index is not a library index within {MAX_ENTRIES} entries')
    signature_layer = next((l for l in layers if l.get('mediaType') == SIGNATURE_LAYER), None)
    signature = None
    if signature_layer:
        try:
            signature = json.loads(registry.blob(repo, signature_layer['digest'], limit=MAX_SIGNATURE))
        except ValueError:
            signature = {'unreadable': True}
    return index, data, signature, digest


def valid_entry(entry):
    return isinstance(entry, dict) and isinstance(entry.get('id'), str) and isinstance(entry.get('repo'), str) \
        and isinstance(entry.get('tag'), str) and DIGEST.fullmatch(str(entry.get('manifestDigest')))


# ----- the library key (spec §4) -----
def key_id(public_raw):
    return hashlib.sha256(public_raw).hexdigest()[:16]


def message(digest):
    return SIGNED_PREFIX + digest.encode() + b'\n'


def load_keys(path):
    keys_path = Path(path) if path else DEFAULT_KEYS
    if not keys_path.exists():
        if path:
            fail(f'{path} does not exist')
        return []
    keys = json.loads(keys_path.read_text()).get('keys', [])
    if not all(isinstance(k, dict) and isinstance(k.get('keyId'), str) and isinstance(k.get('publicKeyHex'), str) for k in keys):
        fail(f'{keys_path} is not a key list')
    return keys


def load_key(path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        fail(f'{path} is not an Ed25519 key')
    return key


def public_raw(key):
    from cryptography.hazmat.primitives import serialization
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def sign(key, digest):
    signature = key.sign(message(digest))
    return {'alg': 'ed25519', 'keyId': key_id(public_raw(key)), 'signed': digest,
            'signature': base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}


def verify(signature, digest, keys):
    """'signed by <keyId>' or the reason it is not"""
    if not signature:
        return 'unsigned'
    if not isinstance(signature, dict) or not all(isinstance(signature.get(k), str) for k in ('alg', 'keyId', 'signed', 'signature')):
        return 'BAD SIGNATURE (unreadable)'
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    if signature['alg'] != 'ed25519' or signature['signed'] != digest:
        return 'BAD SIGNATURE (it does not cover these entries)'
    known = {k['keyId']: k['publicKeyHex'] for k in keys}
    if signature['keyId'] not in known:
        return f'signed by a key this list does not carry ({signature["keyId"][:16]})'
    try:
        raw = base64.urlsafe_b64decode(signature['signature'] + '=' * (-len(signature['signature']) % 4))
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(known[signature['keyId']])).verify(raw, message(digest))
    except (InvalidSignature, ValueError):
        return 'BAD SIGNATURE'
    return f'signed by {signature["keyId"]}'


def index_state(registry, keys):
    index, data, signature, digest = read_signed_index(registry)
    return index, data, digest, (verify(signature, sha(data), keys) if data else 'empty')


def write_index(registry, data, key):
    repo = registry.repo('index')
    digest = registry.push_blob(repo, data)
    empty = registry.push_blob(repo, b'{}')
    layers = [oci.descriptor(oci.INDEX_LAYER, data, digest, 'index.json')]
    if key:
        signature = canonical(sign(key, digest))
        layers.append(oci.descriptor(SIGNATURE_LAYER, signature, registry.push_blob(repo, signature), 'index.signature.json'))
    manifest = {'schemaVersion': 2, 'mediaType': oci.MANIFEST, 'artifactType': oci.INDEX_ARTIFACT,
                'config': oci.descriptor(oci.EMPTY_CONFIG, b'{}', empty), 'layers': layers}
    registry.push_manifest(repo, 'latest', manifest)
    return digest


def held_version(registry, repo, version, kind, config, raw, digest, stored_size):
    """The digest and stored size already published at this version when its content is this work's, else refuse"""
    body, held = raw_manifest(registry, repo, version)
    if body is None:
        return None, None
    if held == digest:
        return held, stored_size
    manifest = json.loads(body)
    types = media(kind)
    layer = next((l for l in manifest['layers'] if l.get('mediaType') in (types['gzip'], types['layer'])), None)
    same = manifest.get('artifactType') == types['artifact'] and layer is not None and manifest.get('config') \
        and registry.blob(repo, manifest['config']['digest'], limit=MAX_CONFIG) == config
    if same:
        stored = registry.blob(repo, layer['digest'], limit=MAX_STORED)
        same = (gunzip(stored) if layer['mediaType'] == types['gzip'] else stored) == raw
    if not same:
        fail(f'{repo}:{version} is already published with other content; give the new content a new version')
    return held, len(stored)


# ----- commands -----
def cmd_keygen(args):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    out = Path(args.dir)
    out.mkdir(parents=True, exist_ok=True)
    private, public = out / 'library-ed25519.pem', out / 'library-key.json'
    if private.exists() or public.exists():
        fail(f'{out} already holds a library key; a key is never overwritten')
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    descriptor = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(pem)
    raw = public_raw(key)
    record = {'keyId': key_id(raw), 'publicKeyHex': raw.hex(), 'alg': 'ed25519', 'created': stamp(now()),
              'purpose': 'Lamplighter library key: signs the study library index (lamplighter-formats docs/LIBRARY-OCI.md §4)'}
    public.write_text(json.dumps(record, indent=2) + '\n')
    print(f'library key {record["keyId"]} -> {private} (private) and {public}')


def cmd_publish(args):
    manifest_path = Path(args.works)
    plan = json.loads(manifest_path.read_text())
    keys = load_keys(args.keys)
    key = load_key(args.key) if args.key else None
    if key and key_id(public_raw(key)) not in {k['keyId'] for k in keys}:
        fail(f'key {key_id(public_raw(key))} is not in the key list the app ships; a new key ships in an update before anything is signed with it')
    registry = oci.Registry(args.registry, args.user, args.password)
    index, data, index_digest, state = index_state(registry, keys)
    held_entries = [e for e in index.get('entries', []) if valid_entry(e)]
    if key and held_entries and not state.startswith('signed by') and not args.adopt_unverified:
        fail(f'the index here is {state}; signing it would vouch for entries no valid signature covers: '
             f'{", ".join(sorted(e["id"] for e in held_entries))}. Check them, then re-run with --adopt-unverified.')
    if not key and state.startswith('signed by') and not args.unsigned:
        fail('the index here is signed; publishing without --key would leave it unsigned, and the app would stop '
             'accepting it. Pass --key, or --unsigned if that is intended.')
    definitions = {**(index.get('definitions') or {}), **(plan.get('definitions') or {})}
    check_definitions(definitions)
    works = plan.get('works') or []
    ids = [w.get('id') for w in works]
    if len(set(ids)) != len(ids):
        fail('a work id appears twice in ' + str(manifest_path))
    checked = [(work, *check_work(work, definitions, manifest_path.parent, args.draft_format)) for work in works]
    entries = {e['id']: e for e in held_entries}
    for work, _, _ in checked:
        held = entries.get(work['id'])
        if held and (held.get('kind') or 'edition') != work['kind']:
            fail(f'{work["id"]} is already a {held.get("kind") or "edition"} in this index; ids are unique across kinds')
    # Plan every push, and build and check the whole index, before anything is sent
    pushes = []
    for work, raw, stored in checked:
        kind = media(work['kind'])
        repo = registry.repo(f'{KINDS[work["kind"]]}/{work["id"]}')
        facts = entry_facts(work)
        config = canonical(facts)
        manifest = {'schemaVersion': 2, 'mediaType': oci.MANIFEST, 'artifactType': kind['artifact'],
                    'config': oci.descriptor(kind['config'], config, sha(config)),
                    'layers': [oci.descriptor(kind['gzip'], stored, sha(stored), f'{work["id"]}.json.gz')],
                    'annotations': {'org.opencontainers.image.title': work['name'], 'org.opencontainers.image.version': work['version']}}
        digest, size = held_version(registry, repo, work['version'], work['kind'], config, raw, sha(canonical(manifest)), len(stored))
        if digest:
            print(f'unchanged {repo}:{work["version"]}')
        else:
            digest, size = sha(canonical(manifest)), len(stored)
            pushes.append((repo, work['version'], stored, config, manifest, digest, len(raw)))
        entries[work['id']] = {**facts, 'repo': repo, 'tag': work['version'], 'manifestDigest': digest, 'size': size}
    before = len(index.get('entries', []))
    if len(entries) < before and not args.force_index:
        fail(f'index would SHRINK {before} -> {len(entries)} entries; refusing. Re-run with --force-index if that is intended.')
    used = {e['stance']['label'] for e in entries.values() if isinstance(e.get('stance'), dict) and 'label' in e['stance']}
    used |= {label for e in entries.values() if isinstance(e.get('stanceAlso'), list) for label in e['stanceAlso']}
    if used - set(definitions):
        fail(f'labels used but not defined: {", ".join(sorted(map(str, used - set(definitions))))}')
    # generated only grows (spec §5: the app refuses an older index)
    moment, previous = now(), index.get('generated') or ''
    if previous:
        if not isinstance(previous, str) or not STAMP.fullmatch(previous):
            fail(f'the index here has a generated time that is not YYYY-MM-DDTHH:MM:SSZ ({previous!r}); refusing')
        held_time = dt.datetime.strptime(previous, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
        if held_time - moment > dt.timedelta(days=1):
            fail(f'the index here says it was generated at {previous}, in the future; refusing')
        if held_time >= moment:
            moment = held_time + dt.timedelta(seconds=1)
    index = {**index, 'schema': 1, 'generated': stamp(moment), 'publisher': plan.get('publisher') or index.get('publisher', ''),
             'definitions': {label: definitions[label] for label in sorted(definitions)},
             'entries': sorted(entries.values(), key=lambda e: e['id'])}
    data = canonical(index)
    if len(data) > MAX_INDEX or len(index['entries']) > MAX_ENTRIES:
        fail(f'the index would be {len(data)} bytes / {len(index["entries"])} entries; the limit is 4 MiB / {MAX_ENTRIES}')
    # Now send
    for repo, version, stored, config, manifest, digest, unpacked in pushes:
        registry.push_blob(repo, stored)
        registry.push_blob(repo, config)
        sent = registry.push_manifest(repo, version, manifest)
        if sent != digest:
            fail(f'{repo}:{version}: the registry stored the manifest as {sent}, not {digest}')
        print(f'pushed {repo}:{version} ({len(stored)} bytes stored, {unpacked} unpacked)')
    _, _, _, now_digest = read_signed_index(registry)
    if now_digest != index_digest:
        fail('the index changed while this ran; it was not replaced. Run publish again.')
    entries_digest = write_index(registry, data, key)
    state = f'signed by {key_id(public_raw(key))}' if key else 'UNSIGNED'
    print(f'index {registry.repo("index")}:latest lists {len(entries)} entries, {state}; {len(pushes)} pushed; entries {entries_digest}')


def cmd_catalog(args):
    registry = oci.Registry(args.registry, args.user, args.password)
    index, data, _, state = index_state(registry, load_keys(args.keys))
    definitions = index.get('definitions') or {}
    names = {label: str(d.get('name', label)) for label, d in definitions.items() if isinstance(d, dict)}
    malformed = 0
    for entry in index.get('entries', []):
        if not valid_entry(entry):
            malformed += 1
            print(f'malformed  {str(entry)[:120]}')
            continue
        kind = str(entry.get('kind') or 'edition')
        stance = entry.get('stance') if isinstance(entry.get('stance'), dict) else {}
        label = names.get(stance.get('label'), '')
        detail = ' · '.join(str(x) for x in (entry.get('author'), entry.get('date'), entry.get('coverage'), label) if x)
        print(f'{kind:10} {entry["id"]:26} {entry.get("name")} · {detail or entry.get("languageEnglishName")} · {entry.get("size")} bytes · {entry["repo"]}:{entry["tag"]}')
    print(f'{len(index.get("entries", []))} entries, generated {index.get("generated") or "never"}, {state}')
    if state.startswith('BAD'):
        fail(f'the index signature does not hold: {state}')
    if malformed:
        fail(f'{malformed} malformed entries')
    if args.require_signed and not state.startswith('signed by'):
        fail(f'the index is {state}, and --require-signed was given')


def cmd_pull(args):
    registry = oci.Registry(args.registry, args.user, args.password)
    index, _, _, state = index_state(registry, load_keys(args.keys))
    if state.startswith('BAD') or (args.require_signed and not state.startswith('signed by')):
        fail(f'the index is {state}; nothing pulled')
    if not state.startswith('signed by'):
        print(f'note: the index is {state}', file=sys.stderr)
    entry = next((e for e in index.get('entries', []) if isinstance(e, dict) and e.get('id') == args.id), None)
    if not entry:
        fail(f'{args.id} is not in the index')
    if not valid_entry(entry):
        fail(f'{args.id} has no pinned sha256 manifest digest')
    kind = entry.get('kind') or 'edition'
    if kind not in KINDS:
        fail(f'{args.id} is a {kind}; use oci-editions.py pull for editions')
    body, _ = raw_manifest(registry, entry['repo'], entry['manifestDigest'])
    if body is None:
        fail(f'{entry["repo"]}@{entry["manifestDigest"]} is missing')
    manifest = json.loads(body)
    types = media(kind)
    if manifest.get('artifactType') != types['artifact']:
        fail(f'{args.id} is not a Lamplighter {kind} artifact')
    layer = next((l for l in manifest['layers'] if l.get('mediaType') in (types['gzip'], types['layer'])), None)
    if not layer:
        fail(f'{args.id} has no {kind} layer')
    data = registry.blob(entry['repo'], layer['digest'], limit=MAX_STORED)
    if layer['mediaType'] == types['gzip']:
        data = gunzip(data)
    elif len(data) > MAX_UNPACKED:
        fail(f'{args.id} is over the 64 MiB limit')
    out = args.out or f'{args.id}.json'
    Path(out).write_bytes(data)
    print(f'pulled {entry["repo"]}:{entry["tag"]} -> {out} ({len(data)} bytes)')


def cmd_export_static(args):
    registry = oci.Registry(args.registry, args.user, args.password)
    out = Path(args.dir)
    if out.exists() and any(out.iterdir()):
        fail(f'{out} is not empty; export into a new directory')
    index, _, _, state = index_state(registry, load_keys(args.keys))
    if state.startswith('BAD') or (args.require_signed and not state.startswith('signed by')):
        fail(f'the index is {state}; nothing exported')
    prefix = registry.repo('')
    for entry in index.get('entries', []):
        if not valid_entry(entry) or not NAME.fullmatch(entry['repo']) or not entry['repo'].startswith(prefix) or not TAG.fullmatch(entry['tag']):
            fail(f'an entry has an unsafe or malformed repo, tag or digest: {str(entry)[:160]}')
        if (entry.get('kind') or 'edition') in KINDS and SHAREABLE.get(entry.get('format')) != entry.get('kind') and not args.draft_format:
            fail(f'{entry["id"]}: {entry.get("format")} is not a format the app shares Lamplighter to Lamplighter yet; not exported')
    root = (out / 'v2').resolve()
    written = {'manifests': 0, 'blobs': 0}

    def put(relative, data):
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            fail(f'refusing to write outside {root}: {relative}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def export(repo, references):
        exported = []
        for reference in references:
            body, digest = raw_manifest(registry, repo, reference)
            if body is None:
                fail(f'{repo}:{reference} is missing')
            manifest = json.loads(body)
            for blob in [b for b in [manifest.get('config')] + manifest['layers'] if b]:
                target = f'{repo}/blobs/{blob["digest"]}'
                if not (root / target).exists():
                    put(target, registry.blob(repo, blob['digest'], limit=MAX_STORED))
                    written['blobs'] += 1
            put(f'{repo}/manifests/{digest}', body)
            if not DIGEST.fullmatch(reference):
                put(f'{repo}/manifests/{reference}', body)
                exported.append(reference)
            written['manifests'] += 1
        put(f'{repo}/tags/list', canonical({'name': repo, 'tags': sorted(exported)}))

    export(registry.repo('index'), ['latest'])
    for entry in index.get('entries', []):
        export(entry['repo'], sorted(set(tags(registry, entry['repo']) or [entry['tag']])) + [entry['manifestDigest']])
    put('index.json', b'{}')
    print(f'exported {len(index.get("entries", []))} entries ({state}): {written["manifests"]} manifests, {written["blobs"]} blobs -> {root}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    keygen = sub.add_parser('keygen')
    keygen.add_argument('dir')
    keygen.set_defaults(handler=cmd_keygen)
    for name, handler in (('publish', cmd_publish), ('catalog', cmd_catalog), ('pull', cmd_pull), ('export-static', cmd_export_static)):
        p = sub.add_parser(name)
        p.add_argument('registry')
        p.add_argument('--user', default=os.environ.get('OCI_USER', ''))
        p.add_argument('--password', default=os.environ.get('OCI_PASSWORD', ''))
        p.add_argument('--keys', help='the public key list to check signatures with (default: library-keys.json in library/ or internals/library/)')
        p.set_defaults(handler=handler)
        if name == 'publish':
            p.add_argument('works', help='WORKS.json: publisher, definitions and works')
            p.add_argument('--key', help='the library key (PEM); without it the index is unsigned')
            p.add_argument('--force-index', action='store_true', help='allow the index to shrink')
            p.add_argument('--adopt-unverified', action='store_true', help='sign entries no valid signature covered, after checking them')
            p.add_argument('--unsigned', action='store_true', help='replace a signed index with an unsigned one')
        if name in ('publish', 'export-static'):
            p.add_argument('--draft-format', action='store_true', help='allow formats the app does not share yet (staging only)')
        if name in ('catalog', 'pull', 'export-static'):
            p.add_argument('--require-signed', action='store_true', help='fail unless the index verifies with the key list')
        if name == 'pull':
            p.add_argument('id')
            p.add_argument('--out')
        elif name == 'export-static':
            p.add_argument('dir')
    args = parser.parse_args()
    args.handler(args)


if __name__ == '__main__':
    main()
