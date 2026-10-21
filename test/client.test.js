'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const tls = require('tls');
const nodeCrypto = require('crypto');
const DeepalClient = require('../lib/DeepalClient');
const { aesCbcEncrypt, aesCbcDecrypt, canonicalString } = require('../lib/crypto');
const { parsePublish } = require('../lib/mqtt');

/** Replace fetch with a fake gateway; `routes` maps a path suffix to a handler(body, headers). */
function fakeGateway(routes) {
  const calls = [];
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ url, path, body, headers: init.headers });
    const route = Object.keys(routes).find(suffix => path.endsWith(suffix));
    if (!route) return new Response(JSON.stringify({ success: false, code: 'NOT_FOUND', msg: path }), { status: 404 });
    const data = await routes[route](body, init.headers);
    return new Response(JSON.stringify({ success: true, code: '0', data }), { status: 200 });
  };
  return calls;
}

test('email login registers a pubKey, then a lock command is signed with it', async () => {
  let registeredPubKey = null;
  let sentCommand = null;
  const calls = fakeGateway({
    '/email-send-auth-code': () => null,
    '/email-code-in': body => {
      registeredPubKey = body.pubKey;
      return { token: 'access-1', refreshToken: 'refresh-1', cacToken: 'cac-1', userId: 'user-1' };
    },
    '/security-code/get-status': () => ({ retryQuantity: 5 }),
    '/security-code/check-code': () => ({ rcToken: 'rc-1' }),
    '/serial-no/get': () => {
      const key = nodeCrypto.createPublicKey({ key: Buffer.from(registeredPubKey.replace(/\n/g, ''), 'base64'), format: 'der', type: 'spki' });
      return nodeCrypto.publicEncrypt({ key, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, Buffer.from('SN-9')).toString('base64');
    },
    '/control/doors': body => {
      sentCommand = body;
      return { commandId: 'cmd-1' };
    },
  });

  let saved = null;
  const client = new DeepalClient({ country: 'NO', onSessionChange: s => { saved = s; } });
  await client.requestEmailCode('me@example.com');
  await client.loginWithEmailCode('me@example.com', ' 123456 ');
  assert.strictEqual(saved.accessToken, 'access-1');
  assert.ok(saved.privateKeyPem.includes('PRIVATE KEY'));
  assert.notStrictEqual(calls[0].body.email, 'me@example.com', 'email is RSA-encrypted');
  assert.strictEqual(calls[1].body.salesCountry, 'NO');

  client.controlPin = '000000';
  const commandId = await client.setLocked('car-1', true);
  assert.strictEqual(commandId, 'cmd-1');
  assert.strictEqual(sentCommand.open, false);
  assert.strictEqual(sentCommand.seriralNo, 'SN-9');
  assert.strictEqual(sentCommand.rcToken, 'rc-1');

  const verifyKey = nodeCrypto.createPublicKey({ key: Buffer.from(registeredPubKey.replace(/\n/g, ''), 'base64'), format: 'der', type: 'spki' });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(canonicalString(sentCommand)), verifyKey, Buffer.from(sentCommand.sign, 'base64')));
  const doorsCall = calls.find(call => call.path.endsWith('/control/doors'));
  assert.strictEqual(doorsCall.headers.authorization, 'access-1|cac-1');
  assert.strictEqual(doorsCall.headers['X-Tsp-User-Token'], 'access-1');
});

test('an auth rejection refreshes the session once and retries', async () => {
  let vehicleCalls = 0;
  global.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/refresh-token')) {
      return new Response(JSON.stringify({ success: true, data: { token: 'access-2' } }));
    }
    vehicleCalls += 1;
    if (vehicleCalls === 1) return new Response(JSON.stringify({ success: false, code: 'APP_1_1_02_003', msg: 'kicked' }));
    return new Response(JSON.stringify({ success: true, data: { list: [{ carId: 7, vin: 'VIN', protocolType: 'MQTT' }] } }));
  };
  const client = new DeepalClient({ session: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
  const vehicles = await client.getVehicles();
  assert.strictEqual(vehicles[0].carId, '7');
  assert.strictEqual(client.accessToken, 'access-2');
});

/** A plain-TCP fake of the CA broker that speaks just enough MQTT 5 for the S05 exchange. */
function startFakeBroker(secretKey, conditionParams) {
  const seen = { connect: null, publishes: [] };
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = 0;
        let multiplier = 1;
        let pos = 1;
        let byte;
        do {
          byte = buffer[pos++];
          length += (byte & 0x7f) * multiplier;
          multiplier *= 128;
        } while (byte & 0x80);
        if (buffer.length < pos + length) return;
        const first = buffer[0];
        const body = buffer.subarray(pos, pos + length);
        buffer = buffer.subarray(pos + length);
        handle(first, body);
      }
    });
    const publish = (topic, payload) => {
      const t = Buffer.from(topic);
      const p = Buffer.from(JSON.stringify(payload));
      const bodyLength = 2 + t.length + 1 + p.length;
      const header = bodyLength < 128 ? Buffer.from([0x30, bodyLength]) : Buffer.from([0x30, (bodyLength % 128) | 0x80, Math.floor(bodyLength / 128)]);
      socket.write(Buffer.concat([header, Buffer.from([t.length >> 8, t.length & 0xff]), t, Buffer.from([0]), p]));
    };
    function handle(first, body) {
      const type = first >> 4;
      if (type === 1) {
        seen.connect = body;
        socket.write(Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]));
      } else if (type === 8) {
        socket.write(Buffer.from([0x90, 0x04, body[0], body[1], 0x00, 0x01]));
      } else if (type === 3) {
        const { topic, payload } = parsePublish(first, body);
        seen.publishes.push({ topic, payload });
        if (topic.endsWith('/client/loginout')) {
          publish('$vdp/DEV1/server/loginout', { r: payload.r, rs: [{ service_code: 'login', params: { secretKey } }] });
        } else if (topic.endsWith('/properties/get/req')) {
          const requested = aesCbcDecrypt(payload.sers, secretKey, payload.r);
          assert.strictEqual(requested[0].service_code, 'car_condition');
          const rs = aesCbcEncrypt([{ service_code: 'car_condition', params: conditionParams }], secretKey, payload.r);
          publish('$vdp/CAR9/properties/get/res', { r: payload.r, rs });
        }
      } else if (type === 14) {
        socket.end();
      }
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('S05 MQTT exchange: CA bootstrap, broker login, encrypted condition', async t => {
  const secretKey = 'abcdef0123456789';
  const params = {
    lastUpdatedTime: '2026-10-20T08:00:00Z', soc: 71, remainedPowerMile: 300, totalOdometer: 5000, ChrgSts: 0,
    driverDoor: 0, passengerDoor: 0, leftRearDoor: 0, rightRearDoor: 0, trunk: 0, driverDoorLock: 0, vehicleTemperature: 19,
  };
  const { server, port, seen } = await startFakeBroker(secretKey, params);
  t.after(() => server.close());

  // The fake broker is plain TCP; make tls.connect hand back a TCP socket.
  const originalConnect = tls.connect;
  tls.connect = ({ host, port: p }) => {
    const socket = net.connect(p, host);
    socket.once('connect', () => socket.emit('secureConnect'));
    return socket;
  };
  t.after(() => { tls.connect = originalConnect; });

  fakeGateway({
    '/getConnConf': body => {
      assert.strictEqual(body.carId, 'car-9');
      return {
        mqttConnectionInfos: [{
          clusterInfos: [{ brokerUrl: 'ssl://127.0.0.1', brokerPort: port, clientId: 'client-1', userName: 'user-1' }],
          topicInfos: [
            { msgType: 'loginout', pubTopics: ['$vdp/DEV1/client/loginout'], subTopics: ['$vdp/DEV1/server/loginout'] },
            { msgType: 'properties', pubTopics: ['$vdp/CAR9/properties/get/req'], subTopics: ['$vdp/CAR9/properties/get/res'] },
          ],
        }],
      };
    },
    '/getAuthTokenByUserId': body => {
      assert.strictEqual(body.userId, 'user-1');
      return { authToken: 'mqtt-password' };
    },
  });

  const client = new DeepalClient({ session: { accessToken: 'a', refreshToken: 'r', userId: 'user-1' } });
  const condition = await client.getMqttCondition('car-9');
  assert.strictEqual(condition.source, 'mqtt');
  assert.strictEqual(condition.socPercent, 71);
  assert.strictEqual(condition.rangeKm, 300);
  assert.strictEqual(condition.insideTemperatureC, 19);
  assert.strictEqual(condition.chargerConnected, false);
  assert.strictEqual(condition.locked, true);

  assert.ok(seen.connect.includes(Buffer.from('mqtt-password')), 'CA auth token is the MQTT password');
  assert.ok(seen.connect.includes(Buffer.from('client-1')));
  const login = seen.publishes.find(p => p.topic === '$vdp/DEV1/client/loginout').payload;
  assert.strictEqual(login.mt, 'loginout');
  assert.strictEqual(login.b.uid, 'user-1');
});
