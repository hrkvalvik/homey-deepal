'use strict';

const crypto = require('crypto');
const {
  encryptRequestValue,
  generateLoginKeypair,
  publicKeyBodyFromPrivate,
  signPayload,
  decryptSerialNo,
  jwtExpiry,
} = require('./crypto');
const { normalizeS05Params, parseCondition } = require('./condition');
const { S05Session } = require('./mqtt');
const {
  DeepalError,
  DeepalConnectionError,
  DeepalAPIError,
  DeepalAuthError,
  DeepalSessionInvalidated,
  DeepalRateLimitError,
  DeepalCommandAuthError,
  DeepalCommandNotReady,
} = require('./errors');

/**
 * Client for the international My Changan / Deepal platform, ported from
 * deepal_sdk/deepal/intl.py (https://github.com/Sunek0/ha-deepal-alternative).
 */

const ENVIRONMENTS = {
  release_eu: {
    label: 'Europe',
    appId: 'ca',
    baseUrl: 'https://m.iov.changanauto.com.de',
    caBaseUrl: 'https://ca-m.iov.changanauto.com.de',
  },
  release_znm: {
    label: 'Latin America',
    appId: 'ca',
    baseUrl: 'https://m.mx.changanauto.link',
    caBaseUrl: 'https://m.mx.changanauto.link',
  },
};

const P = '/intl-app-gw';
const PATHS = {
  sendEmailCode: `${P}/intl-app-auth/api/login/email-send-auth-code`,
  loginByEmailCode: `${P}/intl-app-auth/api/login/email-code-in`,
  sendSmsCode: `${P}/intl-app-auth/api/login/send-auth-code`,
  loginBySmsCode: `${P}/intl-app-auth/api/login/login-by-mobile-code`,
  refreshToken: `${P}/intl-app-auth/api/auth/refresh-token`,
  vehicles: `${P}/intl-app-user/api/car/vehicles`,
  condition: `${P}/intl-app-car-condition/api/vehicle/condition`,
  serialNo: `${P}/intl-app-car-control/api/serial-no/get`,
  securityCodeStatus: `${P}/intl-app-car-control/api/security-code/get-status`,
  checkControlCode: `${P}/intl-app-car-control/api/security-code/check-code`,
  airConditioner: `${P}/intl-app-car-control/api/control/air-conditioner`,
  doors: `${P}/intl-app-car-control/api/control/doors`,
  windows: `${P}/intl-app-car-control/api/control/windows`,
  trunk: `${P}/intl-app-car-control/api/control/trunk`,
  flashingHonking: `${P}/intl-app-car-control/api/control/flashing-honking`,
  chargePercentage: `${P}/intl-app-car-control/api/charge/percentage`,
  seatsHeat: `${P}/intl-app-car-control/api/control/seats/heat`,
  steeringWheelHeat: `${P}/intl-app-car-control/api/control/steering-wheel/heat`,
  controlResult: `${P}/intl-app-car-control/api/control/control-result`,
  caConnConf: '/user-apigw/vot-connect-conf-center/api/device/getConnConf',
  caCarConfFunc: '/user-apigw/vot-connect-conf-center/api/device/appGetCarConfFunc',
  caAuthToken: '/user-apigw/vot-connect-auth-center/api/auth/getAuthTokenByUserId',
};

const FLASH_HONK = { FLASH: 1, HORN: 2, FLASH_AND_HORN: 3 };

const AUTH_ERROR_CODES = new Set(['APP_1_1_02_003', 'APP_1_1_02_004', 'APP_1_1_02_005', 'APP_1_1_02_006', 'CAC_1_1_01_045', '46000']);
const REFRESH_THROTTLE_MS = 30 * 60 * 1000;
const MQTT_TOKEN_TTL_MS = 60 * 1000;
const MQTT_CONFIG_TTL_MS = 660 * 1000;
const HTTP_TIMEOUT_MS = 30000;

function authFailureClass(code, message) {
  if (code != null) {
    const text = String(code);
    if (text.toUpperCase().includes('AUTH') || text.startsWith('401') || AUTH_ERROR_CODES.has(text)) return DeepalAuthError;
  }
  if (message == null) return null;
  const lowered = String(message).toLowerCase();
  if (lowered.includes('rctoken')) return null;
  if (lowered.includes('token') && ['invalid', 'invalidated', 'expired', 'caduc'].some(m => lowered.includes(m))) {
    return DeepalSessionInvalidated;
  }
  return null;
}

class DeepalClient {

  /**
   * @param {object} options
   * @param {string} [options.country] Sales country (ISO code), e.g. "NO".
   * @param {string} [options.language] e.g. "en_US".
   * @param {string} [options.environment] release_eu | release_znm
   * @param {object} [options.session] A session previously returned by getSession().
   * @param {function} [options.onSessionChange] Called with getSession() whenever tokens change.
   * @param {function} [options.log] Logger.
   */
  constructor({
    country = 'GB', language = 'en_US', environment = 'release_eu', session = {}, onSessionChange = null, log = () => {},
  } = {}) {
    const env = ENVIRONMENTS[environment];
    if (!env) throw new Error(`Unknown environment ${environment}`);
    this.country = country;
    this.language = language;
    this.environment = environment;
    this.env = env;
    this.onSessionChange = onSessionChange;
    this.log = log;

    this.deviceId = session.deviceId || crypto.randomBytes(16).toString('hex');
    this.accessToken = session.accessToken || null;
    this.refreshToken = session.refreshToken || null;
    this.cacToken = session.cacToken || null;
    this.userId = session.userId || null;
    this.privateKeyPem = session.privateKeyPem || null;
    this.publicKey = session.publicKey || null;
    this.rcToken = null;
    this.controlPin = null;

    this._lastRefreshAttempt = 0;
    this._refreshPromise = null;
    this._mqttToken = null;
    this._mqttTokenExpires = 0;
    this._mqttConfigs = new Map();
    this._mqttQueue = Promise.resolve();
  }

  get isLoggedIn() {
    return Boolean(this.accessToken && this.refreshToken);
  }

  /** Everything that must survive an app restart. Treat as a secret. */
  getSession() {
    return {
      deviceId: this.deviceId,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      cacToken: this.cacToken,
      userId: this.userId,
      privateKeyPem: this.privateKeyPem,
      publicKey: this.publicKey,
      country: this.country,
      language: this.language,
      environment: this.environment,
    };
  }

  _sessionChanged() {
    if (this.onSessionChange) this.onSessionChange(this.getSession());
  }

  // --- HTTP ----------------------------------------------------------------------

  _headers() {
    const headers = {
      appid: this.env.appId,
      language: this.language,
      appversion: 'V1.12.0',
      apptype: 'Android',
      devicetype: 'samsung',
      deviceid: this.deviceId,
      selectcountry: this.country,
      'x-os-version': '9',
      'accept-language': this.language,
      'content-type': 'application/json; charset=UTF-8',
      'user-agent': 'okhttp/4.12.0',
    };
    if (this.accessToken) {
      headers.authorization = this.cacToken && !this.accessToken.includes('|')
        ? `${this.accessToken}|${this.cacToken}`
        : this.accessToken;
      headers['X-Tsp-User-Token'] = this.accessToken;
      headers['X-VCS-User-Token'] = this.accessToken;
    }
    return headers;
  }

  async _request(path, body = {}, { auth = false, baseUrl = null } = {}) {
    if (auth && !this.accessToken) throw new DeepalAuthError('Not logged in.');
    const url = `${baseUrl || this.env.baseUrl}${path}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new DeepalConnectionError(`Failed to connect to Deepal API: ${err.message}`);
    }
    if (response.status === 429) throw new DeepalRateLimitError('Deepal rate limit: HTTP 429.', { statusCode: 429 });
    if (response.status === 401 || response.status === 403) {
      throw new DeepalAuthError(`Authentication failed with HTTP ${response.status}.`, { statusCode: response.status });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new DeepalAPIError(`Invalid JSON response (HTTP ${response.status})`, { statusCode: response.status });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new DeepalAPIError('Unexpected Deepal response', { statusCode: response.status });
    }

    if (payload.success === false) {
      const code = payload.code != null ? String(payload.code) : null;
      const msg = payload.msg || payload.message || `HTTP ${response.status}`;
      const opts = { code, statusCode: response.status };
      if (code === 'CAC_1_1_01_033') throw new DeepalRateLimitError(`Deepal rate limit: ${code} ${msg}`, opts);
      if (code === 'HW_1_1_01_047') {
        throw new DeepalRateLimitError('Too many PIN attempts; wait for the lockout or reset the PIN in the My Changan app.', opts);
      }
      if (code === 'HW_1_1_01_073' || code === 'HW_1_1_01_074') {
        throw new DeepalCommandAuthError('Remote-control PIN expired or not set; set or reset it in the My Changan app.', opts);
      }
      if (code === 'COMMON_1_1_01_001' && path.endsWith('/serial-no/get')) {
        throw new DeepalCommandAuthError('Command signing was rejected; log in again to register a new signing key.', opts);
      }
      const AuthClass = authFailureClass(code, msg);
      if (AuthClass) throw new AuthClass(`Authentication failed: ${code} ${msg}`, opts);
      throw new DeepalAPIError(`API error: ${code ? `${code} ` : ''}${msg}`, opts);
    }
    if (!response.ok) {
      throw new DeepalAPIError(`API error: HTTP ${response.status}`, { code: payload.code, statusCode: response.status });
    }
    return payload.data;
  }

  /** Authenticated request that refreshes the session once on an auth rejection. */
  async _authed(path, body, options = {}) {
    if (this._accessTokenExpiresSoon()) {
      await this.refreshTokens().catch(err => this.log('Proactive token refresh failed:', err.message));
    }
    try {
      return await this._request(path, body, { ...options, auth: true });
    } catch (err) {
      if (!(err instanceof DeepalAuthError) || !this.refreshToken) throw err;
      await this.refreshTokens({ force: true });
      return this._request(path, body, { ...options, auth: true });
    }
  }

  // --- Login and session -----------------------------------------------------

  _ensurePubKey() {
    if (this.publicKey) return this.publicKey;
    if (this.privateKeyPem) {
      this.publicKey = publicKeyBodyFromPrivate(this.privateKeyPem);
      return this.publicKey;
    }
    const pair = generateLoginKeypair();
    this.privateKeyPem = pair.privateKeyPem;
    this.publicKey = pair.publicKey;
    return this.publicKey;
  }

  _storeTokens(data) {
    if (!data || typeof data !== 'object' || !data.token) {
      throw new DeepalAuthError('Login response did not contain an access token.');
    }
    this.accessToken = String(data.token);
    this.refreshToken = data.refreshToken || null;
    this.cacToken = data.cacToken || null;
    this.userId = data.userId || null;
    this._sessionChanged();
  }

  async requestEmailCode(email) {
    await this._request(PATHS.sendEmailCode, { type: '0', email: encryptRequestValue(email) });
  }

  async loginWithEmailCode(email, code) {
    const data = await this._request(PATHS.loginByEmailCode, {
      authCode: String(code).trim(),
      salesCountry: this.country,
      email: encryptRequestValue(email),
      pubKey: this._ensurePubKey(),
    });
    this._storeTokens(data);
  }

  async requestSmsCode(phone, countryCode) {
    await this._request(PATHS.sendSmsCode, {
      countryCode: String(countryCode).replace(/^\+/, ''),
      mobile: encryptRequestValue(phone),
    });
  }

  async loginWithSmsCode(phone, code, countryCode) {
    const data = await this._request(PATHS.loginBySmsCode, {
      authCode: String(code).trim(),
      countryCode: String(countryCode).replace(/^\+/, ''),
      mobile: encryptRequestValue(phone),
      salesCountry: this.country,
      pubKey: this._ensurePubKey(),
    });
    this._storeTokens(data);
  }

  _accessTokenExpiresSoon(marginSeconds = 300) {
    const exp = jwtExpiry(this.accessToken);
    return exp !== null && Date.now() / 1000 >= exp - marginSeconds;
  }

  /**
   * Refresh the session. Throttled to the app's 30-minute window unless the
   * token is about to expire or `force` is set; concurrent callers share one request.
   */
  async refreshTokens({ force = false } = {}) {
    if (!this.refreshToken) throw new DeepalAuthError('No refresh token is available.');
    if (this._refreshPromise) return this._refreshPromise;
    if (!force && Date.now() - this._lastRefreshAttempt < REFRESH_THROTTLE_MS && !this._accessTokenExpiresSoon()) {
      return undefined;
    }
    this._lastRefreshAttempt = Date.now();
    this._refreshPromise = (async () => {
      try {
        const data = await this._request(PATHS.refreshToken, { refreshToken: this.refreshToken });
        if (!data || !data.token) throw new DeepalAuthError('Refresh response did not contain an access token.');
        this.accessToken = String(data.token);
        this.refreshToken = data.refreshToken || this.refreshToken;
        this.cacToken = data.cacToken || this.cacToken;
        this.userId = data.userId || this.userId;
        this._mqttToken = null;
        this._sessionChanged();
      } finally {
        this._refreshPromise = null;
      }
    })();
    return this._refreshPromise;
  }

  // --- Vehicles and telemetry ------------------------------------------------

  async getVehicles() {
    const data = await this._authed(PATHS.vehicles, {});
    const items = Array.isArray(data) ? data : (data && data.list) || [];
    return items.map(item => ({
      carId: String(item.carId || item.car_id || ''),
      vin: item.vin || '',
      seriesName: item.seriesName || 'Deepal',
      seriesCode: item.seriesCode || null,
      modelName: item.modelName || null,
      nickName: item.nickName || item.carName || null,
      licensePlate: item.licensePlate || item.plateNumber || null,
      imageUrl: item.imgUrl || item.vehicleImageUrl || item.imageUrl || item.carImageUrl || item.modelImageUrl || null,
      protocolType: item.protocolType || null,
    }));
  }

  static isMqttVehicle(protocolType) {
    return protocolType === 'MQTT';
  }

  /** REST condition. For `MQTT` vehicles (S05) this is a frozen snapshot. */
  async getRestCondition(vehicleId) {
    const vechileCriteria = {
      seat: '1', door: '1', hvac: '1', charge: '1', lamp: '1', window: '1', tire: '1', vehicleStatus: '1', fuel: '1',
    };
    const raw = await this._authed(PATHS.condition, { vechileCriteria, vehicleId });
    return { ...parseCondition(raw && typeof raw === 'object' ? raw : {}), source: 'rest' };
  }

  // --- MQTT (S05) ----------------------------------------------------------------

  async _getMqttConfig(vehicleId) {
    const cached = this._mqttConfigs.get(vehicleId);
    if (cached && Date.now() < cached.expires) return cached.data;
    const body = {
      deviceId: this.deviceId,
      carId: vehicleId,
      deviceType: 1,
      confTimestamp: 0,
      deviceTimestamp: String(Date.now()),
    };
    let data;
    try {
      data = await this._authed(PATHS.caConnConf, body, { baseUrl: this.env.caBaseUrl });
    } catch (err) {
      if (err instanceof DeepalRateLimitError || !(err instanceof DeepalAPIError || err instanceof DeepalSessionInvalidated)) throw err;
      this.log('getConnConf failed, retrying appGetCarConfFunc:', err.message);
      data = await this._authed(PATHS.caCarConfFunc, body, { baseUrl: this.env.caBaseUrl });
    }
    if (!data || typeof data !== 'object') throw new DeepalAPIError('Unexpected S05 MQTT configuration response.');
    this._mqttConfigs.set(vehicleId, { data, expires: Date.now() + MQTT_CONFIG_TTL_MS });
    return data;
  }

  async _getMqttToken() {
    if (!this.userId) throw new DeepalAPIError('MQTT telemetry requires the account user id; log in again.');
    if (this._mqttToken && Date.now() < this._mqttTokenExpires) return this._mqttToken;
    const data = await this._authed(PATHS.caAuthToken, { userId: this.userId }, { baseUrl: this.env.caBaseUrl });
    if (!data || !data.authToken) throw new DeepalAPIError('MQTT auth response did not include authToken.');
    this._mqttToken = String(data.authToken);
    this._mqttTokenExpires = Date.now() + MQTT_TOKEN_TTL_MS;
    return this._mqttToken;
  }

  /**
   * Run `fn(session)` on a fresh S05 MQTT session. Sessions are serialized
   * because the broker closes concurrent sessions sharing the account identity.
   */
  _withMqttSession(vehicleId, fn) {
    const run = async () => {
      const config = await this._getMqttConfig(vehicleId);
      const token = await this._getMqttToken();
      let session;
      try {
        session = await S05Session.open(config, token, this.userId);
      } catch (err) {
        if (err.connackRejected) {
          this._mqttToken = null;
          this._mqttConfigs.delete(vehicleId);
        }
        throw err;
      }
      try {
        return await fn(session);
      } finally {
        session.close();
      }
    };
    const result = this._mqttQueue.then(run, run);
    this._mqttQueue = result.catch(() => {});
    return result;
  }

  /** Live condition over MQTT. Does not wake the car; a sleeping car may return little or nothing. */
  async getMqttCondition(vehicleId) {
    const params = await this._withMqttSession(vehicleId, session => session.readCondition());
    if (!Object.keys(params).length) throw new DeepalAPIError('MQTT telemetry did not return vehicle condition.');
    return { ...parseCondition(normalizeS05Params(params)), source: 'mqtt' };
  }

  /**
   * Wake an S05 and wait (up to `timeoutMs`) for a report newer than
   * `previousTimestamp` (seconds). Returns the condition, or null if none arrived.
   */
  async wakeAndWaitForReport(vehicleId, previousTimestamp = null, timeoutMs = 60000) {
    return this._withMqttSession(vehicleId, async session => {
      await session.wake();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const params = await session.readCondition(Math.min(20000, deadline - Date.now()));
        const hasTimestamp = ['lastUpdatedTime', 'lastUpdatedAt', 'latestDate'].some(key => key in params);
        if (Object.keys(params).length > 10 && (previousTimestamp === null || hasTimestamp)) {
          const condition = { ...parseCondition(normalizeS05Params(params)), source: 'mqtt' };
          if (previousTimestamp === null || (condition.lastUpdated && condition.lastUpdated > previousTimestamp)) {
            return condition;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      return null;
    });
  }

  // --- Signed remote commands -------------------------------------------------

  async _checkControlCode() {
    if (!this.controlPin) throw new DeepalCommandNotReady('The remote-control PIN is not set in the device settings.');
    const status = await this._authed(PATHS.securityCodeStatus, {});
    const remaining = status && status.retryQuantity != null ? Number(status.retryQuantity) : null;
    if (remaining !== null && Number.isFinite(remaining) && remaining <= 0) {
      throw new DeepalRateLimitError('No PIN attempts left; wait for the lockout or reset the PIN in the My Changan app.');
    }
    const data = await this._authed(PATHS.checkControlCode, { safeCode: encryptRequestValue(this.controlPin) });
    if (!data || !data.rcToken) throw new DeepalCommandAuthError('PIN check did not return an rcToken.');
    this.rcToken = String(data.rcToken);
    return this.rcToken;
  }

  /** Verify a PIN without sending a command (used when the user saves it). */
  async verifyControlPin(pin) {
    const previous = this.controlPin;
    this.controlPin = pin;
    try {
      await this._checkControlCode();
    } catch (err) {
      this.controlPin = previous;
      throw err;
    }
  }

  async _signedCommand(path, vehicleId, payload, { serialType = '1', requireRcToken = false } = {}) {
    if (!this.privateKeyPem) throw new DeepalCommandNotReady('Command-signing key missing; log in again.');
    let reusedRcToken = false;
    if (requireRcToken) {
      if (this.rcToken) reusedRcToken = true;
      else await this._checkControlCode();
    }

    const serialData = await this._authed(PATHS.serialNo, { type: serialType });
    if (typeof serialData !== 'string') throw new DeepalAPIError('Unexpected serial number response.');
    let serialNo;
    try {
      serialNo = decryptSerialNo(serialData, this.privateKeyPem);
    } catch (err) {
      throw new DeepalCommandAuthError('Could not decrypt the vehicle serial number; log in again to register a new signing key.');
    }

    const signed = { ...payload, seriralNo: serialNo, vehicleId };
    if (requireRcToken) signed.rcToken = this.rcToken;
    signed.sign = signPayload(signed, this.privateKeyPem);

    let data;
    try {
      data = await this._authed(path, signed);
    } catch (err) {
      // A cached rcToken expires (about weekly); the server only says so by
      // rejecting a command that reused it. Exchange the PIN again and retry once.
      if (!(requireRcToken && reusedRcToken && this.controlPin) || !(err instanceof DeepalAPIError || err instanceof DeepalAuthError)) {
        throw err;
      }
      this.rcToken = null;
      await this._checkControlCode();
      signed.rcToken = this.rcToken;
      delete signed.sign;
      signed.sign = signPayload(signed, this.privateKeyPem);
      data = await this._authed(path, signed);
    }
    if (!data || !data.commandId) throw new DeepalAPIError('Control command did not return a commandId.');
    return String(data.commandId);
  }

  setAirConditioner(vehicleId, enabled, targetTempC, runTimeMin = 30) {
    return this._signedCommand(PATHS.airConditioner, vehicleId, {
      command: 'air',
      enabled: Boolean(enabled),
      runTime: runTimeMin,
      targetTemp: Math.round(targetTempC * 10),
      windMode: 1,
    });
  }

  /** locked=true locks, false unlocks. Needs the PIN. */
  setLocked(vehicleId, locked) {
    return this._signedCommand(PATHS.doors, vehicleId, { command: 'lock', open: !locked }, { requireRcToken: true });
  }

  setWindows(vehicleId, open) {
    return this._signedCommand(PATHS.windows, vehicleId, { command: 'window', open: Boolean(open), openType: 10 }, { requireRcToken: true });
  }

  setTrunk(vehicleId, open) {
    return this._signedCommand(PATHS.trunk, vehicleId, { command: 'trunk', open: Boolean(open) }, { requireRcToken: true });
  }

  /**
   * Set front seat heating levels (0 = off, 1-3). Only the seats passed are sent:
   * the endpoint rejects nulls, and "off" is `switch: 0` without a level.
   * @param {{driver?: number, passenger?: number}} levels
   */
  setSeatHeat(vehicleId, { driver, passenger } = {}) {
    const payload = { command: 'seats_heat' };
    const add = (prefix, level) => {
      if (level === undefined || level === null) return;
      const value = Math.max(0, Math.min(3, Math.round(Number(level))));
      payload[`${prefix}Switch`] = value > 0 ? 1 : 0;
      if (value > 0) payload[`${prefix}Level`] = value;
    };
    add('master', driver);
    add('copilot', passenger);
    return this._signedCommand(PATHS.seatsHeat, vehicleId, payload);
  }

  setSteeringWheelHeat(vehicleId, on) {
    return this._signedCommand(PATHS.steeringWheelHeat, vehicleId, { command: 'steering_wheel_heating', open: Boolean(on) });
  }

  flashHonk(vehicleId, actionType) {
    return this._signedCommand(PATHS.flashingHonking, vehicleId, { command: 'flash_bee', type: actionType });
  }

  setChargeLimit(vehicleId, percent) {
    return this._signedCommand(PATHS.chargePercentage, vehicleId, {
      chargePercentageMax: Math.round(percent),
      command: 'charge_max',
    }, { serialType: '2' });
  }

  /** Classify a command result: pending | success | already_done | failed. */
  async getCommandResult(vehicleId, commandId) {
    const raw = (await this._authed(PATHS.controlResult, { vehicleId, commandId })) || {};
    const code = raw.resultCode != null ? String(raw.resultCode) : null;
    let status = 'failed';
    if (code === null || code === '-100') status = 'pending';
    else if (code === '0' || code === '1201') status = 'success';
    else if (code === '1015') status = 'already_done';
    return { status, message: raw.errorMsg || null, raw };
  }

  /** Poll a command until it settles or `timeoutMs` passes. */
  async waitForCommand(vehicleId, commandId, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await this.getCommandResult(vehicleId, commandId);
      if (result.status !== 'pending') return result;
    }
    return { status: 'pending', message: null, raw: null };
  }

}

DeepalClient.ENVIRONMENTS = ENVIRONMENTS;
DeepalClient.FLASH_HONK = FLASH_HONK;
DeepalClient.errors = {
  DeepalError,
  DeepalConnectionError,
  DeepalAPIError,
  DeepalAuthError,
  DeepalSessionInvalidated,
  DeepalRateLimitError,
  DeepalCommandAuthError,
  DeepalCommandNotReady,
};

module.exports = DeepalClient;
