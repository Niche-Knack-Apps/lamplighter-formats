// Ed25519 from raw 32-byte keys with Node's own crypto, so the tests need no dependency
const crypto = require('node:crypto');

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');     // DER prefix of an Ed25519 public key
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex'); // DER prefix of an Ed25519 seed

const privateKey = seed => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const publicKey = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });

module.exports = {
  getPublicKey: seed => new Uint8Array(crypto.createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(SPKI.length)),
  sign: (message, seed) => new Uint8Array(crypto.sign(null, Buffer.from(message), privateKey(seed))),
  verify: (signature, message, raw) => {
    try { return crypto.verify(null, Buffer.from(message), publicKey(raw), Buffer.from(signature)); } catch { return false; }
  }
};
