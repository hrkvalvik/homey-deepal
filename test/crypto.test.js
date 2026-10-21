'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('crypto');
const c = require('../lib/crypto');

test('canonical string sorts keys, skips sign/class/command and renders booleans and null', () => {
  const canonical = c.canonicalString({
    command: 'air', enabled: true, runTime: 30, targetTemp: 220, windMode: 1, seriralNo: 'SN123', vehicleId: 'car-1', sign: 'x', rcToken: null,
  });
  assert.strictEqual(canonical, 'enabled=true&rcToken=null&runTime=30&seriralNo=SN123&targetTemp=220&vehicleId=car-1&windMode=1');
});

test('signature verifies with the registered public key and uses 76-column MIME base64', () => {
  const { privateKeyPem, publicKey } = c.generateLoginKeypair();
  const payload = { command: 'flash_bee', type: 1, seriralNo: 'S', vehicleId: 'v' };
  const signature = c.signPayload(payload, privateKeyPem);
  assert.ok(signature.endsWith('\n'));
  assert.ok(signature.split('\n').every(line => line.length <= 76));
  const spki = nodeCrypto.createPublicKey({ key: Buffer.from(publicKey.replace(/\n/g, ''), 'base64'), format: 'der', type: 'spki' });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(c.canonicalString(payload)), spki, Buffer.from(signature, 'base64')));
});

test('serial number round trip through PKCS#1 v1.5 without privateDecrypt padding', () => {
  const { privateKeyPem } = c.generateLoginKeypair();
  const encrypted = nodeCrypto.publicEncrypt(
    { key: nodeCrypto.createPublicKey(privateKeyPem), padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
    Buffer.from('SERIAL-42'),
  ).toString('base64');
  assert.strictEqual(c.decryptSerialNo(encrypted.replace(/(.{20})/g, '$1\n'), privateKeyPem), 'SERIAL-42');
});

test('AES-CBC service payload round trip', () => {
  const services = [{ service_code: 'car_condition', params: { soc: 80 } }];
  const blob = c.aesCbcEncrypt(services, '0123456789abcdef', 'did_1');
  assert.deepStrictEqual(c.aesCbcDecrypt(blob, '0123456789abcdef', 'did_1'), services);
});

test('jwtExpiry reads exp', () => {
  const body = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64url');
  assert.strictEqual(c.jwtExpiry(`h.${body}.s`), 1800000000);
  assert.strictEqual(c.jwtExpiry('opaque-token'), null);
});
