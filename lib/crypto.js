'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/** App RSA public key (DER/SPKI, base64) used to encrypt email, phone and PIN. */
const REQUEST_ENCRYPTION_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkyhr43cBPTJ3jLiYsmbUwUp74cMJIOju5vqVzgtuK63Q99qV6iVT8wN5cXlyMtWI2mfOmhIao/fUN821im69MfOHsWXdqQEo5e9v654GPw+bju0pCphEPtD1I0VcyS34QkAu04urSun2U1q3Dr2OICLVWSnLa+01ioKxkaB0D209zXcls2eFQpvRAWm7xxVsoqzSwqp+neu5quOpn+eO/bW0TxcSQ8VZcDEUvadRTLSR0eOWgRuHIBiD2RGqPIPzKCm5A14q1qhxUZ8U0pmYe0Sx7eMy4RVe2iW7fnjc6pxTUMBkercSL26mevYouuCKqyie+LVQAtGa29RMl/lyiwIDAQAB';

/** Commands are signed over every field except these (the app signing policy). */
const SIGN_EXCLUDED_KEYS = new Set(['sign', 'class', 'command']);

/** RSA PKCS#1 v1.5 encryption with the app public key, base64 encoded. */
function encryptRequestValue(value) {
  const key = crypto.createPublicKey({
    key: Buffer.from(REQUEST_ENCRYPTION_PUBLIC_KEY, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(value), 'utf8'))
    .toString('base64');
}

/** Strip the PEM armor lines, keeping the 64-column body and a trailing newline. */
function stripPemArmor(pem) {
  return `${pem.split(/\r?\n/).filter(line => line && !line.startsWith('-----')).join('\n')}\n`;
}

/**
 * Generate the 1024-bit RSA identity the login registers as `pubKey`.
 * Returns { privateKeyPem (PKCS#8), publicKey (app pubKey body) }.
 */
function generateLoginKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicExponent: 65537,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKey: stripPemArmor(publicKey) };
}

/** Derive the app `pubKey` body from a stored private key. */
function publicKeyBodyFromPrivate(privateKeyPem) {
  const pem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  return stripPemArmor(pem);
}

/** Python's base64.encodebytes: 76-column lines, each ending in a newline. */
function base64Mime(buffer) {
  const b64 = buffer.toString('base64');
  const lines = b64.match(/.{1,76}/g) || [''];
  return `${lines.join('\n')}\n`;
}

/** Build the canonical `key=value&...` string the vehicle verifies. */
function canonicalString(payload) {
  return Object.keys(payload)
    .filter(key => !SIGN_EXCLUDED_KEYS.has(key))
    .sort()
    .map(key => {
      let value = payload[key];
      if (typeof value === 'boolean') value = value ? 'true' : 'false';
      else if (value === null || value === undefined) value = 'null';
      return `${key}=${value}`;
    })
    .join('&');
}

/** RSA PKCS#1 v1.5 + SHA-256 signature of the canonical string, MIME base64. */
function signPayload(payload, privateKeyPem) {
  const signature = crypto.sign('sha256', Buffer.from(canonicalString(payload), 'utf8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return base64Mime(signature);
}

/**
 * Decrypt the RSA PKCS#1 v1.5 serial number with the login private key.
 *
 * Node 20+ refuses privateDecrypt with RSA_PKCS1_PADDING (CVE-2023-46809), so
 * this decrypts without padding and removes the type-2 block by hand. The
 * input comes from the authenticated gateway, not an attacker-chosen oracle.
 */
function decryptSerialNo(serialData, privateKeyPem) {
  const ciphertext = Buffer.from(String(serialData).replace(/\s+/g, ''), 'base64');
  const block = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_NO_PADDING },
    ciphertext,
  );
  if (block[0] !== 0x00 || block[1] !== 0x02) {
    throw new Error('Invalid PKCS#1 v1.5 block');
  }
  const separator = block.indexOf(0x00, 2);
  if (separator < 10) {
    throw new Error('Invalid PKCS#1 v1.5 padding');
  }
  return block.subarray(separator + 1).toString('utf8').trim();
}

function b64decodeLoose(value) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** MQTT service payload decryption: AES-CBC(key=secretKey, IV=MD5(reqId)) -> base64 -> gzip -> JSON list. */
function aesCbcDecrypt(encrypted, secretKey, reqId) {
  const iv = crypto.createHash('md5').update(reqId, 'utf8').digest();
  const decipher = crypto.createDecipheriv(aesAlgorithm(secretKey), Buffer.from(secretKey, 'utf8'), iv);
  const plaintext = Buffer.concat([decipher.update(b64decodeLoose(encrypted)), decipher.final()]);
  const compressed = b64decodeLoose(plaintext.toString('utf8').trim());
  const decoded = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  return Array.isArray(decoded) ? decoded : [];
}

/** Inverse of aesCbcDecrypt, used for the condition and wake requests. */
function aesCbcEncrypt(services, secretKey, reqId) {
  const compressedB64 = Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(services), 'utf8')).toString('base64'), 'utf8');
  const iv = crypto.createHash('md5').update(reqId, 'utf8').digest();
  const cipher = crypto.createCipheriv(aesAlgorithm(secretKey), Buffer.from(secretKey, 'utf8'), iv);
  return Buffer.concat([cipher.update(compressedB64), cipher.final()]).toString('base64');
}

function aesAlgorithm(secretKey) {
  const bits = Buffer.byteLength(secretKey, 'utf8') * 8;
  if (![128, 192, 256].includes(bits)) {
    throw new Error(`Unsupported MQTT secretKey length: ${bits} bits`);
  }
  return `aes-${bits}-cbc`;
}

/** Return the `exp` claim (seconds) of a JWT, or null. */
function jwtExpiry(token) {
  if (!token || token.split('.').length < 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp != null ? Number(payload.exp) : null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  REQUEST_ENCRYPTION_PUBLIC_KEY,
  encryptRequestValue,
  generateLoginKeypair,
  publicKeyBodyFromPrivate,
  canonicalString,
  signPayload,
  decryptSerialNo,
  aesCbcDecrypt,
  aesCbcEncrypt,
  jwtExpiry,
};
