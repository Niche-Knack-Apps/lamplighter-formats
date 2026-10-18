#!/usr/bin/env python3
"""Publish Lamplighter editions to any OCI registry, and read them back.

    oci-editions.py push    oci://registry/prefix FILE.json [FILE.json …] [--tag main.r1] [--force-index]
    oci-editions.py pull    oci://registry/prefix EDITION-ID [--out FILE.json]
    oci-editions.py catalog oci://registry/prefix

Each edition becomes an OCI artifact at <prefix>/editions/<id>:<tag> (artifact type
application/vnd.nicheknack.lamplighter.edition.v1, a config blob with the facts Settings lists an
edition by, and one layer: the edition JSON exactly as the app reads it). The index at
<prefix>/index:latest lists every edition pushed so far; push merges into it and refuses to
shrink it unless --force-index is given, as the Choirboy fingerprint exporter does.

Standard library only. Credentials: --user/--password, or OCI_USER/OCI_PASSWORD in the
environment. http:// in the reference keeps plain http (a registry on the LAN); oci:// and
https:// use TLS.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

EDITION_ARTIFACT = 'application/vnd.nicheknack.lamplighter.edition.v1'
EDITION_CONFIG = 'application/vnd.nicheknack.lamplighter.edition.config.v1+json'
EDITION_LAYER = 'application/vnd.nicheknack.lamplighter.edition.v1+json'
INDEX_ARTIFACT = 'application/vnd.nicheknack.lamplighter.index.v1'
INDEX_LAYER = 'application/vnd.nicheknack.lamplighter.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
EMPTY_CONFIG = 'application/vnd.oci.empty.v1+json'


class Registry:
    def __init__(self, reference, user='', password=''):
        match = re.match(r'^(oci|https?)://([^/\s]+)(/.*)?$', reference.strip(), re.I)
        if not match:
            sys.exit('A registry looks like oci://registry.example.com/lamplighter')
        scheme = 'http' if match.group(1).lower() == 'http' else 'https'
        self.origin = f'{scheme}://{match.group(2)}'
        self.prefix = (match.group(3) or '').strip('/')
        self.user, self.password = user, password
        self.bearer = None

    def repo(self, name):
        return f'{self.prefix}/{name}' if self.prefix else name

    # ----- transport with the registry's own auth flow -----
    def _auth(self):
        if self.bearer:
            return {'Authorization': f'Bearer {self.bearer}'}
        if self.user:
            return {'Authorization': 'Basic ' + base64.b64encode(f'{self.user}:{self.password}'.encode()).decode()}
        return {}

    def request(self, method, path, body=None, headers=None, retry=True, absolute=False):
        url = path if absolute else f'{self.origin}/v2/{path}'
        req = urllib.request.Request(url, data=body, method=method)
        for name, value in {**(headers or {}), **self._auth()}.items():
            req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            if error.code == 401 and retry:
                challenge = error.headers.get('WWW-Authenticate', '')
                if challenge.lower().startswith('bearer'):
                    self._token(challenge)
                    return self.request(method, path, body, headers, retry=False, absolute=absolute)
            return error.code, dict(error.headers), error.read()

    def _token(self, challenge):
        params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
        query = {k: params[k] for k in ('service', 'scope') if k in params}
        url = params['realm'] + ('?' + urllib.parse.urlencode(query) if query else '')
        req = urllib.request.Request(url)
        if self.user:
            req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{self.user}:{self.password}'.encode()).decode())
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.loads(response.read())
        self.bearer = data.get('token') or data.get('access_token')
        if not self.bearer:
            sys.exit('the registry\'s token service sent no token')

    # ----- blobs and manifests -----
    def has_blob(self, repo, digest):
        status, _, _ = self.request('HEAD', f'{repo}/blobs/{digest}')
        return status == 200

    def push_blob(self, repo, data):
        digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        if self.has_blob(repo, digest):
            return digest
        status, headers, body = self.request('POST', f'{repo}/blobs/uploads/', body=b'', headers={'Content-Length': '0'})
        if status not in (201, 202):
            sys.exit(f'blob upload start failed for {repo}: {status} {body[:200]!r}')
        location = headers.get('Location') or headers.get('location')
        if not location:
            sys.exit(f'the registry sent no upload location for {repo}')
        url = location if location.startswith('http') else self.origin + location
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode({'digest': digest})
        status, _, body = self.request('PUT', url, body=data, headers={'Content-Type': 'application/octet-stream', 'Content-Length': str(len(data))}, absolute=True)
        if status not in (201, 204):
            sys.exit(f'blob upload failed for {repo}: {status} {body[:200]!r}')
        return digest

    def push_manifest(self, repo, reference, manifest):
        data = json.dumps(manifest, separators=(',', ':'), sort_keys=True).encode()
        status, headers, body = self.request('PUT', f'{repo}/manifests/{reference}', body=data, headers={'Content-Type': MANIFEST})
        if status not in (201, 204):
            sys.exit(f'manifest push failed for {repo}:{reference}: {status} {body[:200]!r}')
        return headers.get('Docker-Content-Digest') or headers.get('docker-content-digest') or 'sha256:' + hashlib.sha256(data).hexdigest()

    def manifest(self, repo, reference):
        status, _, body = self.request('GET', f'{repo}/manifests/{reference}', headers={'Accept': MANIFEST})
        if status == 404:
            return None
        if status != 200:
            sys.exit(f'manifest fetch failed for {repo}:{reference}: {status} {body[:200]!r}')
        return json.loads(body)

    def blob(self, repo, digest):
        status, _, body = self.request('GET', f'{repo}/blobs/{digest}')
        if status != 200:
            sys.exit(f'blob fetch failed for {repo}@{digest}: {status}')
        if 'sha256:' + hashlib.sha256(body).hexdigest() != digest:
            sys.exit(f'blob {digest} did not match its digest')
        return body


def descriptor(media_type, data, digest, title=None):
    desc = {'mediaType': media_type, 'digest': digest, 'size': len(data)}
    if title:
        desc['annotations'] = {'org.opencontainers.image.title': title}
    return desc


def edition_facts(path, data):
    meta = data.get('metadata') or {}
    stem = os.path.splitext(os.path.basename(path))[0]
    edition_id = re.sub(r'[^a-z0-9._-]', '-', (meta.get('id') or meta.get('translationId') or stem).lower())
    books = data.get('books') or []
    if not books:
        sys.exit(f'{path} has no books; it is not an edition file')
    return {
        'schema': 1,
        'id': edition_id,
        'name': meta.get('name') or meta.get('fullName') or meta.get('displayName') or stem.upper(),
        'language': meta.get('language') or 'eng',
        'languageEnglishName': meta.get('languageEnglishName') or meta.get('language') or 'English',
        'license': meta.get('license') if isinstance(meta.get('license'), str) else (meta.get('licenseText') or ''),
        'licenseUrl': meta.get('licenseUrl') or '',
        'attribution': meta.get('attribution') or '',
        'bookCount': len(books),
        'textDirection': meta.get('textDirection') or 'ltr',
        'revision': int(meta.get('revision') or 1),
        'publisher': meta.get('publisher') or os.environ.get('OCI_PUBLISHER', ''),
        'created': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }


def read_index(registry):
    repo = registry.repo('index')
    manifest = registry.manifest(repo, 'latest')
    if not manifest:
        return {'schema': 1, 'generated': '', 'publisher': '', 'entries': []}
    layer = next((l for l in manifest.get('layers', []) if l.get('mediaType') == INDEX_LAYER), None)
    if not layer:
        sys.exit('the registry\'s index has no entries layer')
    return json.loads(registry.blob(repo, layer['digest']))


def write_index(registry, index):
    repo = registry.repo('index')
    data = json.dumps(index, separators=(',', ':'), sort_keys=True).encode()
    digest = registry.push_blob(repo, data)
    empty = registry.push_blob(repo, b'{}')
    manifest = {
        'schemaVersion': 2, 'mediaType': MANIFEST, 'artifactType': INDEX_ARTIFACT,
        'config': descriptor(EMPTY_CONFIG, b'{}', empty),
        'layers': [descriptor(INDEX_LAYER, data, digest, 'index.json')],
    }
    registry.push_manifest(repo, 'latest', manifest)


def cmd_push(args):
    registry = Registry(args.registry, args.user, args.password)
    index = read_index(registry)
    entries = {e['id']: e for e in index.get('entries', []) if isinstance(e, dict) and e.get('id')}
    pushed = 0
    for path in args.files:
        with open(path, 'rb') as handle:
            raw = handle.read()
        data = json.loads(raw)
        facts = edition_facts(path, data)
        repo = registry.repo(f'editions/{facts["id"]}')
        tag = args.tag or f'main.r{facts["revision"]}'
        layer_digest = registry.push_blob(repo, raw)
        config_bytes = json.dumps(facts, separators=(',', ':'), sort_keys=True).encode()
        config_digest = registry.push_blob(repo, config_bytes)
        manifest = {
            'schemaVersion': 2, 'mediaType': MANIFEST, 'artifactType': EDITION_ARTIFACT,
            'config': descriptor(EDITION_CONFIG, config_bytes, config_digest),
            'layers': [descriptor(EDITION_LAYER, raw, layer_digest, os.path.basename(path))],
            'annotations': {'org.opencontainers.image.title': facts['name'], 'org.opencontainers.image.created': facts['created']},
        }
        manifest_digest = registry.push_manifest(repo, tag, manifest)
        if args.latest:
            registry.push_manifest(repo, 'latest', manifest)
        entries[facts['id']] = {
            'id': facts['id'], 'kind': 'edition', 'repo': repo, 'tag': tag, 'manifestDigest': manifest_digest,
            'name': facts['name'], 'language': facts['language'], 'languageEnglishName': facts['languageEnglishName'],
            'license': facts['license'], 'licenseUrl': facts['licenseUrl'], 'attribution': facts['attribution'],
            'bookCount': facts['bookCount'], 'textDirection': facts['textDirection'], 'size': len(raw), 'revision': facts['revision'],
        }
        pushed += 1
        print(f'pushed {repo}:{tag} ({len(raw)} bytes, {facts["bookCount"]} books)')
    before = len(index.get('entries', []))
    if len(entries) < before and not args.force_index:
        sys.exit(f'index would SHRINK {before} -> {len(entries)} entries; refusing. Re-run with --force-index if that is intended.')
    index = {'schema': 1, 'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
             'publisher': args.publisher or index.get('publisher', ''), 'entries': sorted(entries.values(), key=lambda e: e['id'])}
    write_index(registry, index)
    print(f'index {registry.repo("index")}:latest now lists {len(entries)} edition(s); {pushed} pushed')


def cmd_pull(args):
    registry = Registry(args.registry, args.user, args.password)
    entry = next((e for e in read_index(registry).get('entries', []) if e.get('id') == args.edition), None)
    if not entry:
        sys.exit(f'{args.edition} is not in the index')
    manifest = registry.manifest(entry['repo'], entry.get('manifestDigest') or entry.get('tag') or 'latest')
    if not manifest or manifest.get('artifactType') != EDITION_ARTIFACT:
        sys.exit(f'{args.edition} is not a Lamplighter edition artifact')
    layer = next((l for l in manifest.get('layers', []) if l.get('mediaType') == EDITION_LAYER), None)
    if not layer:
        sys.exit(f'{args.edition} has no edition layer')
    data = registry.blob(entry['repo'], layer['digest'])
    out = args.out or f'{args.edition}.json'
    with open(out, 'wb') as handle:
        handle.write(data)
    print(f'pulled {entry["repo"]} -> {out} ({len(data)} bytes)')


def cmd_catalog(args):
    registry = Registry(args.registry, args.user, args.password)
    index = read_index(registry)
    for entry in index.get('entries', []):
        print(f'{entry.get("id"):24} {entry.get("name")} · {entry.get("languageEnglishName")} · {entry.get("bookCount")} books · {entry.get("size")} bytes · {entry.get("repo")}:{entry.get("tag")}')
    print(f'{len(index.get("entries", []))} edition(s), generated {index.get("generated") or "never"}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name, handler in (('push', cmd_push), ('pull', cmd_pull), ('catalog', cmd_catalog)):
        p = sub.add_parser(name)
        p.add_argument('registry')
        p.add_argument('--user', default=os.environ.get('OCI_USER', ''))
        p.add_argument('--password', default=os.environ.get('OCI_PASSWORD', ''))
        p.set_defaults(handler=handler)
        if name == 'push':
            p.add_argument('files', nargs='+')
            p.add_argument('--tag', help='tag for every pushed edition (default main.r<revision>)')
            p.add_argument('--latest', action='store_true', help='also move each edition\'s latest tag')
            p.add_argument('--publisher', default='')
            p.add_argument('--force-index', action='store_true', help='allow the index to shrink')
        elif name == 'pull':
            p.add_argument('edition')
            p.add_argument('--out')
    args = parser.parse_args()
    args.handler(args)


if __name__ == '__main__':
    main()
