/* A small OCI registry for tests: blobs, manifests by tag or digest, tag lists, optional bearer auth.
   artifact() seeds one directly: artifact(repo, tag, { artifactType, config: { mediaType, data }, layers: [{ mediaType, data }] })
   returns the manifest's digest; data is a Buffer or a string. */
const http = require('node:http');
const crypto = require('node:crypto');
function start({ port = 0, token = null, host = '127.0.0.1' } = {}) {
  const blobs = new Map(); const manifests = new Map(); const uploads = new Map(); const log = [];
  const digestOf = buf => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); log.push(`${req.method} ${url.pathname}`);
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (token && url.pathname === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ token })); }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'www-authenticate': `Bearer realm="http://${req.headers.host}/token",service="stub",scope="repository:x:pull"`, 'content-type': 'application/json' });
        return res.end('{"errors":[{"code":"UNAUTHORIZED"}]}');
      }
      let m;
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/$/)) && req.method === 'POST') {
        const id = crypto.randomUUID(); uploads.set(id, m[1]);
        res.writeHead(202, { location: `/v2/${m[1]}/blobs/uploads/${id}` }); return res.end();
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/([^/]+)$/)) && req.method === 'PUT') {
        const digest = url.searchParams.get('digest'); if (digestOf(body) !== digest) { res.writeHead(400); return res.end('digest mismatch'); }
        blobs.set(`${m[1]}@${digest}`, body); res.writeHead(201, { 'docker-content-digest': digest }); return res.end();
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/))) {
        const blob = blobs.get(`${m[1]}@${m[2]}`); if (!blob) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.length }); return res.end(req.method === 'HEAD' ? undefined : blob);
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/manifests\/([^/]+)$/))) {
        const ref = decodeURIComponent(m[2]);
        if (req.method === 'PUT') { const digest = digestOf(body); manifests.set(`${m[1]}:${ref}`, body); manifests.set(`${m[1]}:${digest}`, body); res.writeHead(201, { 'docker-content-digest': digest }); return res.end(); }
        const manifest = manifests.get(`${m[1]}:${ref}`); if (!manifest) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'); }
        res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'content-length': manifest.length, 'docker-content-digest': digestOf(manifest) }); return res.end(req.method === 'HEAD' ? undefined : manifest);
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/tags\/list$/))) {
        const tags = [...manifests.keys()].filter(k => k.startsWith(`${m[1]}:`) && !k.slice(m[1].length + 1).startsWith('sha256:')).map(k => k.slice(m[1].length + 1));
        res.writeHead(tags.length ? 200 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ name: m[1], tags }));
      }
      if (url.pathname === '/v2/') { res.writeHead(200); return res.end('{}'); }
      res.writeHead(404); res.end();
    });
  });
  function artifact(repo, tag, { artifactType, config = null, layers = [], annotations } = {}) {
    const put = ({ mediaType, data }) => { const buf = Buffer.from(data); const digest = digestOf(buf); blobs.set(`${repo}@${digest}`, buf); return { mediaType, digest, size: buf.length }; };
    const empty = { mediaType: 'application/vnd.oci.empty.v1+json', data: '{}' };
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType, config: put(config || empty), layers: layers.map(put), ...(annotations ? { annotations } : {}) }));
    const digest = digestOf(manifest);
    manifests.set(`${repo}:${tag}`, manifest); manifests.set(`${repo}:${digest}`, manifest);
    return digest;
  }
  return new Promise(resolve => server.listen(port, host, () => resolve({ server, port: server.address().port, blobs, manifests, log, artifact, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) })));
}
module.exports = { start };
if (require.main === module) { start({ port: Number(process.argv[2] || 5055), token: process.argv[3] || null }).then(r => console.log(`stub registry on http://127.0.0.1:${r.port}`)); }
