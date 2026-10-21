'use strict';

const tls = require('tls');
const { aesCbcEncrypt, aesCbcDecrypt } = require('./crypto');
const { DeepalAPIError } = require('./errors');

/**
 * Minimal MQTT 5.0 transport and the S05 one-shot condition/wake exchange,
 * ported from deepal_sdk/deepal/mqtt.py. Only the packets the official app
 * uses are implemented: CONNECT, SUBSCRIBE, PUBLISH, PUBACK, PINGREQ and
 * DISCONNECT over TLS. No external MQTT library is needed.
 */

const SOCKET_TIMEOUT_MS = 15000;
const EXCHANGE_TIMEOUT_MS = 20000;
const KEEPALIVE_S = 60;

const LOGIN_PUB_TOPIC_TEMPLATE = did => `$vdp/${did}/client/loginout`;
const LOGIN_SUB_TOPIC_TEMPLATE = did => `$vdp/${did}/server/loginout`;
const EVENT_SUB_TOPIC_TEMPLATE = did => `$vdp/${did}/${did}/server/event`;
const PROPERTIES_SET_TOPIC_TEMPLATE = did => `$vdp/${did}/properties/set/req`;

const COMMAND_TOPIC_MARKERS = ['/commands/', '/set/', '/client/action'];
const COMMAND_MSG_TYPES = new Set(['command', 'commands', 'cmd', 'control', 'set']);
const BASIC_IDENTIFIER_KEYS = ['vin', 'sc', 'mc', 'uid', 'cid', 'ruid'];
const S05_SERVICE_CODES = new Set([null, undefined, 'car_condition', 'BDC_Service', 'BMS_Service', 'OBC_Service', 'THU_Service']);
const WAKE_OK_CODES = new Set(['000000', '0', '00000']);

const CONNACK_REASONS = {
  0x80: 'unspecified error',
  0x84: 'unsupported protocol version',
  0x85: 'client identifier not valid',
  0x86: 'bad user name or password',
  0x87: 'not authorized',
  0x88: 'server unavailable',
  0x89: 'server busy',
  0x8a: 'banned',
  0x9f: 'connection rate exceeded',
};

// --- Packet encoding ---------------------------------------------------------

function mqttString(value) {
  const data = Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
}

function remainingLength(length) {
  const out = [];
  do {
    let encoded = length % 128;
    length = Math.floor(length / 128);
    if (length) encoded |= 128;
    out.push(encoded);
  } while (length);
  return Buffer.from(out);
}

function packet(firstByte, body) {
  return Buffer.concat([Buffer.from([firstByte]), remainingLength(body.length), body]);
}

function uint16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

function buildConnect(clientId, username, password, keepalive = KEEPALIVE_S) {
  const flags = 0xc0 | 0x02; // username + password + clean start
  const variable = Buffer.concat([mqttString('MQTT'), Buffer.from([5, flags]), uint16(keepalive), Buffer.from([0])]);
  return packet(0x10, Buffer.concat([variable, mqttString(clientId), mqttString(username), mqttString(password)]));
}

function buildSubscribe(packetId, topics) {
  const payload = Buffer.concat(topics.map(topic => Buffer.concat([mqttString(topic), Buffer.from([0x01])])));
  return packet(0x82, Buffer.concat([uint16(packetId), Buffer.from([0]), payload]));
}

function buildPublish(topic, payload, { qos = 0, packetId = 1 } = {}) {
  const parts = [mqttString(topic)];
  if (qos > 0) parts.push(uint16(packetId));
  parts.push(Buffer.from([0]), Buffer.from(JSON.stringify(payload), 'utf8'));
  return packet(0x30 | ((qos & 0x03) << 1), Buffer.concat(parts));
}

const buildPuback = packetId => Buffer.concat([Buffer.from([0x40, 0x04]), uint16(packetId), Buffer.from([0, 0])]);
const PINGREQ = Buffer.from([0xc0, 0x00]);
const DISCONNECT = Buffer.from([0xe0, 0x02, 0x00, 0x00]);

function readVarInt(data, pos) {
  let multiplier = 1;
  let value = 0;
  while (pos < data.length) {
    const byte = data[pos++];
    value += (byte & 0x7f) * multiplier;
    if (!(byte & 0x80)) return [value, pos];
    multiplier *= 128;
  }
  throw new Error('Truncated MQTT variable byte integer');
}

function parsePublish(first, body) {
  let pos = 0;
  const topicLength = body.readUInt16BE(pos);
  pos += 2;
  const topic = body.subarray(pos, pos + topicLength).toString('utf8');
  pos += topicLength;
  let packetId = null;
  if ((first >> 1) & 0x03) {
    packetId = body.readUInt16BE(pos);
    pos += 2;
  }
  const [propertiesLength, next] = readVarInt(body, pos);
  pos = next + propertiesLength;
  const payload = JSON.parse(body.subarray(pos).toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('MQTT PUBLISH payload is not a JSON object');
  }
  return { topic, payload, packetId };
}

// --- TLS connection with a packet queue ---------------------------------------

class MqttConnection {

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.packets = [];
    this.waiter = null;
    this.error = null;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._drain();
    });
    const fail = err => {
      this.error = err || new Error('MQTT connection closed');
      if (this.waiter) this.waiter();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(this.error));
  }

  static connect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DeepalAPIError(`MQTT connect to ${host}:${port} timed out`));
      }, SOCKET_TIMEOUT_MS);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(new MqttConnection(socket));
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(new DeepalAPIError(`MQTT connect failed: ${err.message}`));
      });
    });
  }

  _drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      let multiplier = 1;
      let length = 0;
      let pos = 1;
      let complete = false;
      while (pos < this.buffer.length && pos < 5) {
        const byte = this.buffer[pos++];
        length += (byte & 0x7f) * multiplier;
        if (!(byte & 0x80)) {
          complete = true;
          break;
        }
        multiplier *= 128;
      }
      if (!complete || this.buffer.length < pos + length) return;
      this.packets.push({ first: this.buffer[0], body: this.buffer.subarray(pos, pos + length) });
      this.buffer = this.buffer.subarray(pos + length);
      if (this.waiter) this.waiter();
    }
  }

  write(data) {
    this.socket.write(data);
  }

  /** Read one packet within `timeoutMs`, sending PINGREQ at the keepalive. Resolves null on timeout. */
  async read(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let nextPing = Date.now() + KEEPALIVE_S * 1000;
    for (;;) {
      if (this.packets.length) return this.packets.shift();
      if (this.error) throw new DeepalAPIError(`MQTT connection lost: ${this.error.message}`);
      const now = Date.now();
      if (now >= deadline) return null;
      if (now >= nextPing) {
        this.write(PINGREQ);
        nextPing = now + KEEPALIVE_S * 1000;
      }
      const wait = Math.min(deadline, nextPing) - now;
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, wait);
        this.waiter = () => {
          clearTimeout(timer);
          this.waiter = null;
          resolve();
        };
      });
    }
  }

  /** Read the next PUBLISH (acknowledging QoS 1), skipping other packets. Null on timeout. */
  async readPublish(deadline) {
    while (Date.now() < deadline) {
      const pkt = await this.read(Math.max(50, deadline - Date.now()));
      if (!pkt) return null;
      if (pkt.first >> 4 !== 3) continue;
      let message;
      try {
        message = parsePublish(pkt.first, pkt.body);
      } catch (err) {
        continue;
      }
      if (message.packetId !== null) this.write(buildPuback(message.packetId));
      return message;
    }
    return null;
  }

  close() {
    try {
      this.socket.write(DISCONNECT);
    } catch (err) {
      // already closed
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

}

// --- Connection configuration and topics --------------------------------------

function firstObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value.find(item => item && typeof item === 'object' && !Array.isArray(item)) || null;
  return null;
}

function configSources(config) {
  if (!config || typeof config !== 'object') return [];
  const sources = [config];
  const info = firstObject(config.mqttConnectionInfos);
  if (info && info !== config) {
    sources.push(info);
    const cluster = firstObject(info.clusterInfos);
    if (cluster) sources.push(cluster);
  }
  return sources;
}

function firstString(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key]) return source[key];
  }
  return null;
}

function topicEntries(value, msgType = null) {
  const entries = [];
  if (value == null) return entries;
  if (typeof value === 'string') return [[value, msgType]];
  if (Array.isArray(value)) {
    for (const item of value) entries.push(...topicEntries(item, msgType));
    return entries;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$vdp')) {
        if (typeof item === 'string' && item) entries.push([key, item]);
        else if (item && typeof item === 'object') entries.push([key, item.msgType || item.msg_type || null]);
        else entries.push([key, null]);
        continue;
      }
      if (typeof item === 'string') {
        entries.push([item, key]);
      } else if (Array.isArray(item)) {
        for (const nested of item) {
          if (typeof nested === 'string') entries.push([nested, key]);
          else if (nested && typeof nested === 'object') {
            const topic = nested.topic || nested.pubTopic || nested.subTopic;
            if (typeof topic === 'string') entries.push([topic, nested.msgType || nested.msg_type || key]);
          }
        }
      } else if (item && typeof item === 'object') {
        let nested = item.pubTopics || item.subTopics || item.topics;
        if (nested == null && item.topic) nested = [item.topic];
        entries.push(...topicEntries(nested, item.msgType || item.msg_type || key));
      }
    }
  }
  return entries;
}

function classifyTopic(topic, msgType, direction) {
  if (!topic) return null;
  const lowered = topic.toLowerCase();
  if (lowered.includes('/properties/set/')) {
    return direction === 'sub' || lowered.endsWith('/res') ? 'properties_subscribe' : 'properties_set_publish';
  }
  if (COMMAND_TOPIC_MARKERS.some(marker => lowered.includes(marker))) return 'command';
  const kind = msgType == null ? null : String(msgType).trim().toLowerCase() || null;
  if (COMMAND_MSG_TYPES.has(kind)) return 'command';
  if (lowered.includes('loginout')) {
    return lowered.includes('/client/') || direction === 'pub' ? 'login_publish' : 'login_subscribe';
  }
  if (kind === 'loginout' || kind === 'login') return direction === 'pub' ? 'login_publish' : 'login_subscribe';
  if (lowered.includes('properties')) {
    return lowered.endsWith('/res') || direction === 'sub' ? 'properties_subscribe' : 'properties_publish';
  }
  if (['properties', 'property', 'car_condition'].includes(kind)) {
    return direction === 'pub' ? 'properties_publish' : 'properties_subscribe';
  }
  if (lowered.includes('event') || kind === 'event' || kind === 'events') return 'event';
  return null;
}

function topicDeviceId(topic) {
  if (!topic) return null;
  const parts = topic.split('/');
  return parts.length > 2 && parts[0] === '$vdp' ? parts[1] : null;
}

function configTopicEntries(config) {
  const entries = [];
  for (const source of configSources(config)) {
    for (const info of source.topicInfos || []) {
      if (!info || typeof info !== 'object') continue;
      const msgType = info.msgType || info.msg_type || null;
      for (const topic of info.pubTopics || []) if (typeof topic === 'string') entries.push([topic, msgType, 'pub']);
      for (const topic of info.subTopics || []) if (typeof topic === 'string') entries.push([topic, msgType, 'sub']);
    }
    for (const [key, direction] of [['pubTopicMap', 'pub'], ['subTopicMap', 'sub'], ['allSubTopics', 'sub']]) {
      for (const [topic, msgType] of topicEntries(source[key])) entries.push([topic, msgType, direction]);
    }
    const topicToMsgType = source.topicToMsgtype || source.topicToMsgType;
    if (topicToMsgType && typeof topicToMsgType === 'object') {
      for (const [topic, msgType] of Object.entries(topicToMsgType)) {
        if (typeof msgType === 'string') entries.push([topic, msgType, null]);
      }
    }
  }
  return entries;
}

/** Resolve the telemetry topics and device ids from the CA connection configuration. */
function resolveTopics(config) {
  const selected = {};
  const subscriptions = [];
  for (const [topic, msgType, direction] of configTopicEntries(config)) {
    const kind = classifyTopic(topic, msgType, direction);
    if (kind === null) {
      if (direction === 'sub') subscriptions.push(topic);
      continue;
    }
    if (kind === 'command') continue;
    if (!(kind in selected)) selected[kind] = topic;
    if (direction === 'sub' || ['login_subscribe', 'properties_subscribe', 'event'].includes(kind)) {
      subscriptions.push(topic);
    }
  }

  let loginDid = topicDeviceId(selected.login_publish || selected.login_subscribe);
  let deviceDid = topicDeviceId(
    selected.properties_publish || selected.properties_subscribe || selected.login_publish || selected.login_subscribe,
  );
  let explicitDid = null;
  for (const source of configSources(config)) {
    explicitDid = firstString(source, ['clientId', 'client_id', 'clientID', 'client', 'did', 'userName']);
    if (explicitDid) break;
  }
  const did = deviceDid || loginDid || explicitDid;

  if (!selected.properties_publish && selected.properties_subscribe && selected.properties_subscribe.endsWith('/res')) {
    selected.properties_publish = `${selected.properties_subscribe.slice(0, -4)}/req`;
  }
  if (!selected.properties_set_publish && selected.properties_publish && selected.properties_publish.includes('/properties/get/')) {
    selected.properties_set_publish = selected.properties_publish.replace('/properties/get/', '/properties/set/');
  }
  if (did) {
    selected.login_publish = selected.login_publish || LOGIN_PUB_TOPIC_TEMPLATE(did);
    selected.login_subscribe = selected.login_subscribe || LOGIN_SUB_TOPIC_TEMPLATE(did);
    selected.event = selected.event || EVENT_SUB_TOPIC_TEMPLATE(did);
    selected.properties_set_publish = selected.properties_set_publish || PROPERTIES_SET_TOPIC_TEMPLATE(did);
    loginDid = loginDid || did;
    deviceDid = deviceDid || did;
  }
  for (const kind of ['login_subscribe', 'event']) {
    if (selected[kind]) subscriptions.push(selected[kind]);
  }

  return {
    loginPublish: selected.login_publish || null,
    propertiesPublish: selected.properties_publish || null,
    propertiesSetPublish: selected.properties_set_publish || null,
    subscriptions: [...new Set(subscriptions)],
    loginDid,
    deviceDid,
  };
}

function mqttIdentity(config, loginDid) {
  let clientId = null;
  let username = null;
  for (const source of configSources(config)) {
    clientId = clientId || firstString(source, ['clientId', 'client_id', 'clientID', 'client']);
    username = username || firstString(source, ['userName', 'username', 'user']);
  }
  return { clientId: clientId || loginDid, username: username || loginDid };
}

function basicIdentifiers(config, loginDid, userId) {
  const info = firstObject(config.mqttConnectionInfos) || {};
  const cluster = firstObject(info.clusterInfos) || {};
  let carData = info.carConfigJson;
  if (typeof carData === 'string' && carData.trim().startsWith('{')) {
    try {
      carData = JSON.parse(carData);
    } catch (err) {
      carData = {};
    }
  }
  if (!carData || typeof carData !== 'object') carData = {};
  const sources = [info, cluster, carData, config];
  const firstValue = (...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        if (source[key] != null && String(source[key])) return String(source[key]);
      }
    }
    return null;
  };
  const candidates = {
    vin: firstValue('vin'),
    uid: userId || firstValue('userId', 'uid'),
    cid: firstValue('carId', 'car_id', 'cid'),
    ruid: loginDid,
  };
  const result = {};
  for (const key of BASIC_IDENTIFIER_KEYS) {
    if (candidates[key] != null) result[key] = candidates[key];
  }
  return result;
}

// --- Payloads -------------------------------------------------------------------

const isoNow = () => new Date().toISOString();
const newRequestId = did => `${did}_${Date.now() * 1000 + Math.floor(Math.random() * 1000)}`;

function envelope(did, reqId, mt, basicInfo, sers, encrypted) {
  return {
    did,
    r: reqId,
    v: 'v1.0.0',
    mt,
    e: encrypted ? 1 : 0,
    z: encrypted ? 'gzip' : 'unzip',
    tf: 0,
    dt: isoNow(),
    ...(encrypted ? { b: basicInfo, sers } : { sers, b: basicInfo }),
  };
}

function loginRequest(loginDid, reqId, basicInfo) {
  return envelope(loginDid, reqId, 'loginout', basicInfo, [{
    service_code: 'login',
    params: { encryptEnable: 1, zipType: 'gzip', ts: Date.now() },
  }], false);
}

function conditionRequest(deviceDid, secretKey, reqId, basicInfo) {
  const services = [{ service_code: 'car_condition', params: { fetchPropertyType: 0 } }];
  return { ...envelope(deviceDid, reqId, 'properties', basicInfo, aesCbcEncrypt(services, secretKey, reqId), true), rt: '' };
}

function wakeRequest(deviceDid, secretKey, reqId, basicInfo) {
  const services = [{
    service_code: 'TxWakeup', command_code: 'Cnr_ReWakeup', service_req_id: reqId, params: {},
  }];
  return envelope(deviceDid, reqId, 'properties', basicInfo, aesCbcEncrypt(services, secretKey, reqId), true);
}

function secretFromLogin(payload) {
  for (const item of payload.rs || []) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['params', 'data']) {
      if (item[key] && typeof item[key] === 'object' && item[key].secretKey) return String(item[key].secretKey);
    }
  }
  return null;
}

function decryptServices(payload, secretKey) {
  if (typeof payload.r !== 'string') return [];
  const items = [];
  for (const field of ['rs', 'sers']) {
    const encrypted = payload[field];
    if (typeof encrypted !== 'string' || !encrypted) continue;
    try {
      items.push(...aesCbcDecrypt(encrypted, secretKey, payload.r));
    } catch (err) {
      // not encrypted with this session key
    }
  }
  return items;
}

function paramsFromPayload(payload, secretKey) {
  const params = {};
  for (const item of decryptServices(payload, secretKey)) {
    if (!item || typeof item !== 'object' || !S05_SERVICE_CODES.has(item.service_code)) continue;
    if (item.params && typeof item.params === 'object') Object.assign(params, item.params);
    if (item.data && typeof item.data === 'object') Object.assign(params, item.data);
  }
  return params;
}

// --- Session ----------------------------------------------------------------------

/**
 * One connect/login/close MQTT session against the CA broker.
 * `config` is the getConnConf response and `token` the CA auth token.
 */
class S05Session {

  static async open(config, token, userId) {
    const info = firstObject(config.mqttConnectionInfos) || {};
    const cluster = firstObject(info.clusterInfos) || {};
    const host = String(cluster.brokerUrl || '').replace('ssl://', '');
    const port = Number(cluster.brokerPort) || 8883;
    const topics = resolveTopics(config);
    if (!host || !topics.loginPublish || !topics.loginDid || !topics.deviceDid) {
      throw new DeepalAPIError('S05 MQTT configuration did not include required topics.');
    }
    const { clientId, username } = mqttIdentity(config, topics.loginDid);
    const basicInfo = basicIdentifiers(config, topics.loginDid, userId);

    const conn = await MqttConnection.connect(host, port);
    const session = new S05Session(conn, topics, basicInfo);
    try {
      conn.write(buildConnect(clientId, username, token));
      const connack = await conn.read(SOCKET_TIMEOUT_MS);
      if (!connack || connack.first !== 0x20) throw new DeepalAPIError('S05 MQTT broker sent no CONNACK.');
      const reason = connack.body[1];
      if (reason !== 0) {
        const error = new DeepalAPIError(
          `S05 MQTT broker rejected connection: reason code ${reason} (${CONNACK_REASONS[reason] || 'unknown'})`,
        );
        error.connackRejected = true;
        throw error;
      }
      conn.write(buildSubscribe(1, [...topics.subscriptions].sort()));
      await conn.read(SOCKET_TIMEOUT_MS);

      conn.write(buildPublish(topics.loginPublish, loginRequest(topics.loginDid, newRequestId(topics.loginDid), basicInfo)));
      const deadline = Date.now() + EXCHANGE_TIMEOUT_MS;
      while (!session.secretKey && Date.now() < deadline) {
        const message = await conn.readPublish(deadline);
        if (!message) break;
        session.secretKey = secretFromLogin(message.payload);
      }
      if (!session.secretKey) throw new DeepalAPIError('S05 MQTT login did not return a secretKey.');
      return session;
    } catch (err) {
      conn.close();
      throw err;
    }
  }

  constructor(conn, topics, basicInfo) {
    this.conn = conn;
    this.topics = topics;
    this.basicInfo = basicInfo;
    this.secretKey = null;
  }

  /**
   * Request the car condition and collect the decrypted parameters. Returns as
   * soon as a properties/get/res carries more than 10 parameters, or once the
   * accumulated set exceeds 30, or at the timeout with what was collected.
   */
  async readCondition(timeoutMs = EXCHANGE_TIMEOUT_MS) {
    const { propertiesPublish, deviceDid, loginDid } = this.topics;
    if (!propertiesPublish) throw new DeepalAPIError('S05 MQTT configuration has no properties topic.');
    const reqId = newRequestId(deviceDid);
    const basicInfo = { ...this.basicInfo, ruid: this.basicInfo.ruid || loginDid };
    this.conn.write(buildPublish(propertiesPublish, conditionRequest(deviceDid, this.secretKey, reqId, basicInfo)));

    const deadline = Date.now() + timeoutMs;
    const partial = {};
    for (;;) {
      const message = await this.conn.readPublish(deadline);
      if (!message) return partial;
      const params = paramsFromPayload(message.payload, this.secretKey);
      if (!Object.keys(params).length) continue;
      if (message.topic.endsWith('/properties/get/res') && Object.keys(params).length > 10) return params;
      Object.assign(partial, params);
      if (Object.keys(partial).length > 30) return partial;
    }
  }

  /** Publish the TxWakeup service (QoS 1, so the broker queues it for a sleeping car) and wait for the ack. */
  async wake(timeoutMs = EXCHANGE_TIMEOUT_MS) {
    const { propertiesSetPublish, deviceDid, loginDid } = this.topics;
    if (!propertiesSetPublish) throw new DeepalAPIError('S05 MQTT configuration has no properties/set topic.');
    const reqId = newRequestId(deviceDid);
    const basicInfo = { ...this.basicInfo, ruid: this.basicInfo.ruid || loginDid };
    this.conn.write(buildPublish(propertiesSetPublish, wakeRequest(deviceDid, this.secretKey, reqId, basicInfo), { qos: 1, packetId: 2 }));

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.conn.readPublish(deadline);
      if (!message) throw new DeepalAPIError('Vehicle wake did not return a response.');
      if (message.payload.r !== reqId) continue;
      const result = decryptServices(message.payload, this.secretKey).find(item => item && item.code);
      if (!result) continue;
      if (result.success || WAKE_OK_CODES.has(String(result.code))) return;
      throw new DeepalAPIError(`Vehicle wake was rejected: ${result.code}`, { code: result.code });
    }
  }

  close() {
    this.conn.close();
  }

}

module.exports = {
  S05Session,
  resolveTopics,
  buildConnect,
  buildPublish,
  parsePublish,
  paramsFromPayload,
};
