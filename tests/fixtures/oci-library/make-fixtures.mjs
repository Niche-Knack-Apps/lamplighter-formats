// Writes the O0 fixtures: a library index of every kind and a signature vector with a synthetic key.
// node tests/fixtures/oci-library/make-fixtures.mjs tests/fixtures/oci-library (Ed25519 from tests/support/ed25519.js)
import ed25519 from '../../support/ed25519.js';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fakeDigest = text => `sha256:${sha(Buffer.from(text))}`;

const definitions = {
  reformed: { name: 'Reformed', definition: "Salvation is God's work from first to last: he chooses whom he saves, calls them, and keeps them to the end (Calvinist; the Westminster, 1689 Baptist and Three Forms of Unity confessions)." },
  heretical: { name: 'Traditional heretical', definition: 'A teacher of the early church whom a council of the whole church later condemned by name, kept for his reading of the text: Origen (Constantinople, 553), Didymus the Blind and Evagrius Ponticus (680 and 787).' },
  neutral: { name: 'Neutral', definition: 'Argues no system: language, history, reference, or a creed every tradition confesses.' },
  mixed: { name: 'Per author', definition: "A collection of many writers; each note carries its own writer's label." }
};
const work = (kind, dir, id, fields) => ({
  id, kind, repo: `lamp/${dir}/${id}`, tag: fields.version, manifestDigest: fakeDigest(`${kind}/${id}`), language: 'eng', languageEnglishName: 'English',
  license: 'Public Domain', licenseUrl: '', attribution: '', compressed: true, ...fields
});
const index = {
  schema: 1,
  generated: '2026-11-11T00:00:00Z',
  publisher: 'Niche-Knack Apps (fixture)',
  definitions,
  entries: [
    { id: 'bsb', repo: 'lamp/editions/bsb', tag: 'main.r1', manifestDigest: fakeDigest('edition/bsb'), name: 'Berean Standard Bible', language: 'eng', languageEnglishName: 'English', license: 'Public Domain', licenseUrl: '', attribution: '', bookCount: 66, textDirection: 'ltr', size: 4400000, revision: 1 },
    work('commentary', 'commentaries', 'matthew-henry', { name: "Matthew Henry's Commentary", version: '1.0.0', size: 7100000, author: 'Matthew Henry', date: '1706–1714', coverage: 'Whole Bible', description: 'Verse-by-verse devotional exposition of the whole Bible, finished after his death from his notes.', sourceUrl: 'https://www.crosswire.org/sword/modules/ModInfo.jsp?modName=MHC', format: 'lamplighter-commentary@1', stance: { label: 'reformed', why: 'Presbyterian Nonconformist minister; Westminster theology throughout.' } }),
    work('commentary', 'commentaries', 'church-fathers', { name: 'Church Fathers by verse', version: '1.0.0', size: 9800000, author: 'Many writers', date: '100–750', coverage: 'Whole Bible', description: 'What the early church wrote on each verse, gathered from the Ante-Nicene and Nicene and Post-Nicene Fathers.', sourceUrl: 'https://www.ccel.org/fathers', format: 'lamplighter-commentary@1', stance: { label: 'mixed', why: 'Origen, Didymus the Blind and Evagrius Ponticus Traditional heretical, the rest Neutral.' }, stanceAlso: ['heretical'] }),
    work('confession', 'confessions', 'westminster-confession', { name: 'Westminster Confession of Faith', version: '1.0.0', size: 240000, author: 'Westminster Assembly', date: '1646', coverage: '33 chapters', description: 'The confession of the Westminster Assembly, with every proof text tied to its clause.', sourceUrl: 'https://quod.lib.umich.edu/e/eebo/A80320.0001.001', format: 'lamplighter-confession@1', stance: { label: 'reformed', why: 'A Reformed confession: the standard of the Presbyterian churches.' } }),
    work('study', 'study', 'tsk', { name: 'Treasury of Scripture Knowledge', version: '1.0.0', size: 3900000, author: 'R. A. Torrey (ed.)', date: 'c. 1880', coverage: 'Whole Bible', description: 'About half a million cross-references, verse by verse.', sourceUrl: 'https://www.crosswire.org/sword/modules/ModInfo.jsp?modName=TSK', format: 'lamplighter-crossrefs@1', studyType: 'cross-references', stance: { label: 'neutral', why: 'References only; argues no system.' } }),
    // A kind no app knows yet: every reader ignores it
    work('sermon', 'sermons', 'spurgeon-sermons', { name: 'Spurgeon Sermons', version: '1.0.0', size: 1000, format: 'lamplighter-sermon@1', stance: { label: 'reformed', why: 'Particular Baptist; 1689 Confession.' } })
  ]
};
const entries = Buffer.from(JSON.stringify(index));
writeFileSync(`${OUT}/index-v1.json`, entries);

// Signature vector: a synthetic, deterministic key; never the Lamplighter library key
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const publicKey = ed25519.getPublicKey(seed);
const entriesDigest = `sha256:${sha(entries)}`;
const message = `lamplighter-library-index-v1\n${entriesDigest}\n`;
const signature = ed25519.sign(new TextEncoder().encode(message), seed);
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const vector = {
  purpose: 'Synthetic deterministic test key only; never the Lamplighter library key.',
  seedHex: Buffer.from(seed).toString('hex'),
  publicKeyHex: Buffer.from(publicKey).toString('hex'),
  keyId: sha(Buffer.from(publicKey)).slice(0, 16),
  entriesFile: 'index-v1.json',
  entriesDigest,
  message,
  layer: { alg: 'ed25519', keyId: sha(Buffer.from(publicKey)).slice(0, 16), signed: entriesDigest, signature: b64url(signature) }
};
writeFileSync(`${OUT}/signature-vector.json`, JSON.stringify(vector, null, 2) + '\n');
console.log(entriesDigest, vector.keyId, entries.length);
