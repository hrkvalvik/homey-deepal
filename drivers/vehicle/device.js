'use strict';

const Homey = require('homey');
const DeepalClient = require('../../lib/DeepalClient');

const { DeepalAuthError } = DeepalClient.errors;
const { FLASH_HONK } = DeepalClient;

// Limits taken from the Home Assistant integration (const.py) to protect the 12 V battery.
const WAKE_STALE_AFTER_S = 120;
const WAKE_COOLDOWN_MS = 5 * 60 * 1000;
const WAKE_REPORT_TIMEOUT_MS = 60 * 1000;
const WAKE_BEFORE_COMMAND_TIMEOUT_MS = 30 * 1000;
// The car runs a physical cycle; repeating sooner is rejected by the vehicle.
const ACTION_COOLDOWN_MS = { flash: 30000, horn: 6000, flashAndHorn: 30000 };

const TIRE_CAPABILITIES = {
  frontLeft: 'deepal_tire_pressure.front_left',
  frontRight: 'deepal_tire_pressure.front_right',
  rearLeft: 'deepal_tire_pressure.rear_left',
  rearRight: 'deepal_tire_pressure.rear_right',
};
const TIRE_ALARM_CAPABILITY = 'alarm_generic.tire_pressure';
const SEAT_CAPABILITIES = { driver: 'deepal_seat_heat.driver', passenger: 'deepal_seat_heat.passenger' };
const STEERING_CAPABILITY = 'deepal_steering_wheel_heat';
// After a confirmed change the car can keep reporting the old value for a while;
// reports that disagree are ignored for this long.
const COMMAND_HOLD_MS = 3 * 60 * 1000;

// Only S05 (MQTT) cars report these, so they are added the first time a value arrives.
const WARNING_LIGHTS = [
  { key: 'battery12v', capability: 'alarm_generic.battery_12v', title: { en: '12 V battery warning', no: '12 V-batterivarsel' } },
  { key: 'abs', capability: 'alarm_generic.abs', title: { en: 'ABS warning', no: 'ABS-varsel' } },
  { key: 'brake', capability: 'alarm_generic.brake', title: { en: 'Brake warning', no: 'Bremsevarsel' } },
  { key: 'brakeFluid', capability: 'alarm_generic.brake_fluid', title: { en: 'Brake fluid warning', no: 'Bremsevæskevarsel' } },
  { key: 'eps', capability: 'alarm_generic.power_steering', title: { en: 'Power steering warning', no: 'Servostyringsvarsel' } },
  { key: 'powerLimit', capability: 'alarm_generic.power_limit', title: { en: 'Power limit warning', no: 'Varsel om effektbegrensning' } },
  { key: 'powerSystem', capability: 'alarm_generic.power_system', title: { en: 'Power system warning', no: 'Varsel om kraftsystem' } },
  { key: 'tractionBatteryLow', capability: 'alarm_generic.traction_battery_low', title: { en: 'Traction battery low', no: 'Lavt nivå på traksjonsbatteri' } },
  { key: 'keyBatteryLow', capability: 'alarm_generic.key_battery', title: { en: 'Key fob battery low', no: 'Lavt batteri i nøkkelen' } },
];

class VehicleDevice extends Homey.Device {

  async onInit() {
    this.condition = null;
    this.lastWakeAt = 0;
    this.lastActionAt = {};
    this.polling = false;
    this.holds = {};

    // Cars paired with an older version lack these capabilities.
    for (const capability of [
      ...Object.values(TIRE_CAPABILITIES), TIRE_ALARM_CAPABILITY, ...Object.values(SEAT_CAPABILITIES), STEERING_CAPABILITY,
    ]) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }
    await this.setCapabilityOptions(SEAT_CAPABILITIES.driver, { title: { en: 'Driver seat heating', no: 'Setevarme fører' } }).catch(this.error);
    await this.setCapabilityOptions(SEAT_CAPABILITIES.passenger, { title: { en: 'Passenger seat heating', no: 'Setevarme passasjer' } }).catch(this.error);
    // Options stored on devices paired earlier lack the translated titles from the manifest.
    for (const [capability, options] of Object.entries(this.driver.manifest.capabilitiesOptions || {})) {
      if (options.title && this.hasCapability(capability)) {
        await this.setCapabilityOptions(capability, { title: options.title }).catch(this.error);
      }
    }
    for (const { capability, title } of WARNING_LIGHTS) {
      if (this.hasCapability(capability)) await this.setCapabilityOptions(capability, { title }).catch(this.error);
    }
    this.warningLightTrigger = this.homey.flow.getDeviceTriggerCard('warning_light_on');

    this.registerCapabilityListener('locked', value => this._runCommand(
      client => client.setLocked(this.vehicleId, value), { pin: true },
    ));
    this.registerCapabilityListener('deepal_climate', value => this._setClimate(value, this.getCapabilityValue('target_temperature')));
    this.registerCapabilityListener('target_temperature', async value => {
      if (this.getCapabilityValue('deepal_climate')) await this._setClimate(true, value);
    });
    this.registerCapabilityListener(SEAT_CAPABILITIES.driver, value => this._setSeatHeat({ driver: Number(value) }));
    this.registerCapabilityListener(SEAT_CAPABILITIES.passenger, value => this._setSeatHeat({ passenger: Number(value) }));
    this.registerCapabilityListener(STEERING_CAPABILITY, value => this._setSteeringWheelHeat(value));

    this._schedulePolling();
    this.homey.setTimeout(() => this.poll(), 2000);
  }

  get vehicleId() {
    return this.getData().id;
  }

  get isMqttVehicle() {
    return DeepalClient.isMqttVehicle(this.getStoreValue('protocolType'));
  }

  _client() {
    const client = this.homey.app.getClient();
    client.controlPin = this.getSetting('control_pin') || null;
    return client;
  }

  _schedulePolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const minutes = Math.max(2, Number(this.getSetting('poll_interval')) || 5);
    this.pollTimer = this.homey.setInterval(() => this.poll(), minutes * 60 * 1000);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('control_pin') && newSettings.control_pin) {
      if (!/^\d{6}$/.test(newSettings.control_pin)) throw new Error(this.homey.__('errors.pin_format'));
      // Verified against the account so a wrong PIN is rejected instead of stored.
      await this.homey.app.getClient().verifyControlPin(newSettings.control_pin);
    }
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this._schedulePolling(), 0);
    }
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }

  // --- Telemetry -----------------------------------------------------------------

  /** Periodic poll. Never wakes the car. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const client = this._client();
      let condition = null;
      if (this.isMqttVehicle) {
        try {
          condition = await client.getMqttCondition(this.vehicleId);
        } catch (err) {
          this.log('MQTT condition unavailable, using REST snapshot:', err.message);
        }
      }
      if (condition) await this._overlayComfort(client, condition);
      else condition = await client.getRestCondition(this.vehicleId);
      await this._applyCondition(condition);
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      await this._handleError(err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The S05's MQTT report has no trustworthy steering wheel state and sleeping
   * seat modules report nothing, so take those from the server's condition:
   * the steering wheel whenever it is reported, the seats when that report is
   * not older than the MQTT one.
   */
  async _overlayComfort(client, condition) {
    let rest;
    try {
      rest = await client.getRestCondition(this.vehicleId);
    } catch (err) {
      this.log('Comfort overlay unavailable:', err.message);
      return;
    }
    if (rest.steeringWheelHeat !== null) condition.steeringWheelHeat = rest.steeringWheelHeat;
    const restIsOlder = condition.lastUpdated && rest.lastUpdated && rest.lastUpdated < condition.lastUpdated;
    if (!restIsOlder) {
      for (const seat of Object.keys(SEAT_CAPABILITIES)) {
        if (rest.seatHeat[seat] !== null) condition.seatHeat[seat] = rest.seatHeat[seat];
      }
    }
  }

  /** Wake an S05 and wait for a fresh report, respecting the per-vehicle cooldown. */
  async wakeAndRefresh(timeoutMs = WAKE_REPORT_TIMEOUT_MS) {
    if (!this.isMqttVehicle) return this.poll();
    if (Date.now() - this.lastWakeAt < WAKE_COOLDOWN_MS) {
      this.log('Wake skipped: cooldown active');
      return this.poll();
    }
    this.lastWakeAt = Date.now();
    const previous = this.condition ? this.condition.lastUpdated : null;
    const condition = await this._client().wakeAndWaitForReport(this.vehicleId, previous, timeoutMs);
    if (condition) await this._applyCondition(condition);
    return undefined;
  }

  async _wakeIfStale() {
    if (!this.isMqttVehicle || !this.getSetting('allow_wake')) return;
    const last = this.condition && this.condition.lastUpdated;
    if (last && Date.now() / 1000 - last < WAKE_STALE_AFTER_S) return;
    try {
      await this.wakeAndRefresh(WAKE_BEFORE_COMMAND_TIMEOUT_MS);
    } catch (err) {
      this.log('Wake before command failed, sending anyway:', err.message);
    }
  }

  async _applyCondition(condition) {
    this.condition = condition;
    const set = async (capability, value) => {
      if (value === null || value === undefined || Number.isNaN(value)) return;
      if (!this.hasCapability(capability)) return;
      const hold = this.holds[capability];
      if (hold && Date.now() < hold.until && hold.value !== value) return;
      if (this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(err => this.error(capability, err.message));
      }
    };

    await set('measure_battery', condition.socPercent);
    await set('deepal_range', condition.rangeKm);
    await set('deepal_odometer', condition.odometerKm);
    await set('measure_temperature', condition.insideTemperatureC);
    await set('measure_temperature.outside', condition.outsideTemperatureC);
    await set('measure_humidity', condition.humidityPercent);
    await set('locked', condition.locked);
    await set('deepal_climate', condition.climateOn);
    if (condition.targetTemperatureC !== null && condition.targetTemperatureC >= 16 && condition.targetTemperatureC <= 32) {
      await set('target_temperature', condition.targetTemperatureC);
    }
    for (const [seat, capability] of Object.entries(SEAT_CAPABILITIES)) {
      const level = condition.seatHeat ? condition.seatHeat[seat] : null;
      await set(capability, level === null ? null : String(level));
    }
    await set(STEERING_CAPABILITY, condition.steeringWheelHeat);
    await set('measure_current', condition.chargeCurrentA);
    await set('deepal_charge_time_remaining', condition.remainingChargeTimeMin);

    const doorsOpen = Object.values(condition.doorsOpen).some(Boolean) || condition.hoodOpen;
    await set('alarm_contact.doors', doorsOpen);
    await set('alarm_contact.trunk', condition.trunkOpen);
    await set('alarm_contact.windows', Object.values(condition.windowsOpen).some(Boolean));

    for (const [position, capability] of Object.entries(TIRE_CAPABILITIES)) {
      await set(capability, condition.tires[position].pressureBar);
    }
    const tireAlarms = Object.values(condition.tires).map(tire => tire.alarm).filter(alarm => alarm !== null);
    const tpmsLight = condition.warningLights ? condition.warningLights.tpms : null;
    if (tireAlarms.length || tpmsLight !== null) {
      await set(TIRE_ALARM_CAPABILITY, tireAlarms.some(alarm => alarm !== 0) || tpmsLight === true);
    }

    await this._applyWarningLights(condition);

    const chargingState = this._evChargingState(condition);
    const wasCharging = this.getCapabilityValue('ev_charging_state') === 'plugged_in_charging';
    await set('ev_charging_state', chargingState);
    if (chargingState) {
      const isCharging = chargingState === 'plugged_in_charging';
      if (isCharging && !wasCharging) await this.driver.chargingStartedTrigger.trigger(this).catch(this.error);
      if (!isCharging && wasCharging) await this.driver.chargingStoppedTrigger.trigger(this).catch(this.error);
    }

    if (condition.lastUpdated) {
      await set('deepal_last_update', new Date(condition.lastUpdated * 1000).toLocaleString(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(),
      }));
    }

    this.emitWidgetState();
  }

  /** Pick the text for the Homey language, falling back to English. */
  _localized(text) {
    return text[this.homey.i18n.getLanguage()] || text.en;
  }

  /** Add each warning light on its first report, then trigger the Flow card when one turns on. */
  async _applyWarningLights(condition) {
    const values = { ...(condition.warningLights || {}), keyBatteryLow: condition.keyBatteryLow };
    for (const { key, capability, title } of WARNING_LIGHTS) {
      const value = values[key];
      // null: unknown (not reported, or the car is off and the bits are not trusted).
      if (value === null || value === undefined) continue;
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
        await this.setCapabilityOptions(capability, { title }).catch(this.error);
      }
      const wasOn = this.getCapabilityValue(capability) === true;
      if (this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(err => this.error(capability, err.message));
      }
      if (value && !wasOn) {
        await this.warningLightTrigger.trigger(this, { light: this._localized(title) }).catch(this.error);
      }
    }
  }

  _evChargingState(condition) {
    if (condition.charging === true) return 'plugged_in_charging';
    if (condition.chargerConnected === true) return 'plugged_in';
    if (condition.chargerConnected === false || condition.charging === false) return 'plugged_out';
    return null;
  }

  async _handleError(err) {
    this.error(err.message);
    if (err instanceof DeepalAuthError) {
      await this.setUnavailable(this.homey.__('errors.session_expired')).catch(this.error);
      this.emitWidgetState();
    }
  }

  // --- Dashboard widget ------------------------------------------------------------

  /** Everything the car widget draws, including the per-door detail the capabilities aggregate. */
  getWidgetState() {
    const value = capability => (this.hasCapability(capability) ? this.getCapabilityValue(capability) : null);
    const condition = this.condition;
    const tire = position => ({
      bar: value(TIRE_CAPABILITIES[position]),
      alarm: condition ? Boolean(condition.tires[position].alarm) : false,
    });
    return {
      carId: this.vehicleId,
      name: this.getName(),
      available: this.getAvailable(),
      isMqtt: this.isMqttVehicle,
      hasPin: Boolean(this.getSetting('control_pin')),
      lastUpdated: condition ? condition.lastUpdated : null,
      battery: value('measure_battery'),
      rangeKm: value('deepal_range'),
      chargingState: value('ev_charging_state'),
      chargeCurrentA: value('measure_current'),
      chargeTimeRemainingMin: value('deepal_charge_time_remaining'),
      locked: value('locked'),
      climateOn: value('deepal_climate'),
      targetTemperature: value('target_temperature'),
      insideTemperature: value('measure_temperature'),
      outsideTemperature: value('measure_temperature.outside'),
      doors: condition ? condition.doorsOpen : null,
      windows: condition ? condition.windowsOpen : null,
      hoodOpen: condition ? condition.hoodOpen : null,
      trunkOpen: value('alarm_contact.trunk'),
      anyDoorOpen: value('alarm_contact.doors'),
      anyWindowOpen: value('alarm_contact.windows'),
      tires: {
        frontLeft: tire('frontLeft'),
        frontRight: tire('frontRight'),
        rearLeft: tire('rearLeft'),
        rearRight: tire('rearRight'),
      },
      warnings: WARNING_LIGHTS.filter(light => value(light.capability) === true).map(light => this._localized(light.title)),
      seatHeat: {
        driver: value(SEAT_CAPABILITIES.driver) === null ? null : Number(value(SEAT_CAPABILITIES.driver)),
        passenger: value(SEAT_CAPABILITIES.passenger) === null ? null : Number(value(SEAT_CAPABILITIES.passenger)),
      },
      steeringWheelHeat: value(STEERING_CAPABILITY),
    };
  }

  emitWidgetState() {
    this.homey.api.realtime('deepal:state', this.getWidgetState()).catch(err => this.error('widget realtime', err.message));
  }

  /** Run a widget action. Resolves when the car confirmed it; throws a readable error otherwise. */
  async runWidgetAction(action, value) {
    const setAfter = async (capability, newValue, listener) => {
      await listener;
      await this.setCapabilityValue(capability, newValue).catch(this.error);
    };
    switch (action) {
      case 'lock': await setAfter('locked', true, this.triggerCapabilityListener('locked', true)); break;
      case 'unlock': await setAfter('locked', false, this.triggerCapabilityListener('locked', false)); break;
      case 'climate_on': await this.flowClimateOn({ temperature: Number(value) || this.getCapabilityValue('target_temperature') || 22 }); break;
      case 'climate_off': await this.flowClimateOff(); break;
      case 'set_temperature': {
        const temperature = Math.min(32, Math.max(16, Math.round(Number(value) * 2) / 2));
        await setAfter('target_temperature', temperature, this.triggerCapabilityListener('target_temperature', temperature));
        break;
      }
      case 'flash': await this.flowFlash(); break;
      case 'horn': await this.flowHorn(); break;
      case 'open_trunk': await this.flowOpenTrunk(); break;
      case 'windows_open': await this.flowSetWindows({ state: 'open' }); break;
      case 'windows_close': await this.flowSetWindows({ state: 'close' }); break;
      case 'refresh': await this.flowWakeAndRefresh(); break;
      case 'seat_heat_driver': await this._setSeatHeat({ driver: Number(value) }); break;
      case 'seat_heat_passenger': await this._setSeatHeat({ passenger: Number(value) }); break;
      case 'steering_on': await this._setSteeringWheelHeat(true); break;
      case 'steering_off': await this._setSteeringWheelHeat(false); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
    this.emitWidgetState();
  }

  // --- Commands --------------------------------------------------------------------

  /** Send a signed command, wait for the car to confirm and refresh. Throws a readable error. */
  async _runCommand(send, { pin = false } = {}) {
    if (pin && !this.getSetting('control_pin')) throw new Error(this.homey.__('errors.pin_required'));
    if (pin) await this._wakeIfStale();
    try {
      const client = this._client();
      const commandId = await send(client);
      const result = await client.waitForCommand(this.vehicleId, commandId);
      if (result.status === 'failed') {
        throw new Error(this.homey.__('errors.command_failed', { reason: result.message || result.raw?.resultCode || '?' }));
      }
      this.homey.setTimeout(() => this.poll(), 5000);
    } catch (err) {
      await this._handleError(err);
      throw err;
    }
  }

  _setClimate(enabled, targetTemperature) {
    const temperature = Number(targetTemperature) || 22;
    const runtime = Number(this.getSetting('climate_runtime')) || 30;
    return this._runCommand(client => client.setAirConditioner(this.vehicleId, enabled, temperature, runtime));
  }

  /** Remember a confirmed value so a stale report right after the command cannot flip it back. */
  async _confirm(capability, value) {
    this.holds[capability] = { value, until: Date.now() + COMMAND_HOLD_MS };
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async _setSeatHeat(levels) {
    await this._runCommand(client => client.setSeatHeat(this.vehicleId, levels));
    for (const [seat, level] of Object.entries(levels)) {
      await this._confirm(SEAT_CAPABILITIES[seat], String(level));
    }
    this.emitWidgetState();
  }

  async _setSteeringWheelHeat(on) {
    await this._runCommand(client => client.setSteeringWheelHeat(this.vehicleId, on));
    await this._confirm(STEERING_CAPABILITY, Boolean(on));
    this.emitWidgetState();
  }

  /** Flash/horn actions: refuse while the car still runs the previous cycle; start the cooldown once accepted. */
  async _runTimedAction(action, actionType) {
    const wait = (this.lastActionAt[action] || 0) + ACTION_COOLDOWN_MS[action] - Date.now();
    if (wait > 0) throw new Error(this.homey.__('errors.cooldown', { seconds: Math.ceil(wait / 1000) }));
    await this._runCommand(client => client.flashHonk(this.vehicleId, actionType));
    this.lastActionAt[action] = Date.now();
  }

  // --- Flow card handlers (registered in app.js) -----------------------------------

  async flowClimateOn({ temperature }) {
    await this._setClimate(true, temperature);
    await this.setCapabilityValue('target_temperature', temperature).catch(this.error);
    await this.setCapabilityValue('deepal_climate', true).catch(this.error);
  }

  async flowClimateOff() {
    await this._setClimate(false, this.getCapabilityValue('target_temperature'));
    await this.setCapabilityValue('deepal_climate', false).catch(this.error);
  }

  async flowFlash() {
    await this._runTimedAction('flash', FLASH_HONK.FLASH);
  }

  async flowHorn() {
    await this._runTimedAction('horn', FLASH_HONK.HORN);
  }

  async flowFlashAndHorn() {
    await this._runTimedAction('flashAndHorn', FLASH_HONK.FLASH_AND_HORN);
  }

  async flowOpenTrunk() {
    await this._runCommand(client => client.setTrunk(this.vehicleId, true), { pin: true });
  }

  async flowSetWindows({ state }) {
    await this._runCommand(client => client.setWindows(this.vehicleId, state === 'open'), { pin: true });
  }

  async flowSetChargeLimit({ percent }) {
    // Not supported by the S05 EV (accepted without effect); the PHEV supports it.
    await this._runCommand(client => client.setChargeLimit(this.vehicleId, percent));
  }

  async flowWakeAndRefresh() {
    await this.wakeAndRefresh();
  }

  async flowSetSeatHeat({ seat, level }) {
    const value = Number(level);
    const levels = seat === 'both' ? { driver: value, passenger: value } : { [seat]: value };
    await this._setSeatHeat(levels);
  }

  async flowSetSteeringWheelHeat({ state }) {
    await this._setSteeringWheelHeat(state === 'on');
  }

}

module.exports = VehicleDevice;
