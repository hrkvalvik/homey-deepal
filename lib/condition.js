'use strict';

/**
 * Telemetry mapping ported from deepal_sdk (intl.py parse_condition and
 * mqtt.py normalize_s05_params). The S05 MQTT parameters are first normalized
 * into the REST condition shape, then both paths share parseCondition.
 */

const CHARGE_TIME_SENTINEL = 8191;
const MAX_CHARGE_CURRENT_A = 600;

// S05 ChrgSts: 0 not charging, 1 AC connected, 2 DC connected, 3 AC charging, 4 DC charging.
const CHARGE_STATES = [0, 1, 2, 3, 4];
const CHARGING_STATES = new Set([3, 4]);
const AC_GUN_STATES = new Set([1, 3]);
const DC_GUN_STATES = new Set([2, 4]);

function asInt(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function asFloat(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBool(value) {
  const number = asInt(value);
  return number === null ? null : number !== 0;
}

function first(params, ...keys) {
  for (const key of keys) {
    if (params[key] !== null && params[key] !== undefined) return params[key];
  }
  return null;
}

/** Seat levels are only trusted in 0-3; the sleep sentinel 6 means unknown. */
function seatLevel(value) {
  const level = asInt(value);
  return level === null || level < 0 || level > 3 ? null : level;
}

function chargeState(value) {
  const parsed = asInt(value);
  return CHARGE_STATES.includes(parsed) ? parsed : null;
}

function cleanChargeCurrent(value) {
  const current = asFloat(value);
  if (current === null || current < 0 || current > MAX_CHARGE_CURRENT_A) return null;
  return current;
}

/** Resolve (ac, dc, active) currents against the charging state. */
function chargeCurrents(acValue, dcValue, stateValue) {
  const state = chargeState(stateValue);
  const acReported = asFloat(acValue) !== null;
  const dcReported = asFloat(dcValue) !== null;
  const ac = cleanChargeCurrent(acValue);
  const dc = cleanChargeCurrent(dcValue);
  if (state === 4) return [acReported ? 0 : null, dc, dc];
  if (state === 3) return [ac, dcReported ? 0 : null, ac];
  if (state !== null) {
    return [acReported ? 0 : null, dcReported ? 0 : null, acReported || dcReported ? 0 : null];
  }
  let active = ac !== null && ac !== 0 ? ac : dc;
  if (active === null && ac !== null) active = 0;
  return [ac, dc, active];
}

/** Gun codes 0 and 1 mean "not connected"; higher values mean plugged. */
function gunCodeConnected(value) {
  const code = asInt(value);
  if (code === null) return null;
  return code !== 0 && code !== 1;
}

function chargeGunFlags(stateValue, acGunValue, dcGunValue) {
  const state = chargeState(stateValue);
  if (state !== null) {
    return [state !== 0, AC_GUN_STATES.has(state), DC_GUN_STATES.has(state)];
  }
  const acGun = gunCodeConnected(acGunValue);
  const dcGun = gunCodeConnected(dcGunValue);
  let plugged = null;
  if (acGun || dcGun) plugged = true;
  else if (acGun === false || dcGun === false) plugged = false;
  return [plugged, acGun, dcGun];
}

function toMillis(value) {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string' && value) {
    if (/^\d+$/.test(value)) return Number(value);
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** A sleeping car reports healthy warning bits as 1; trust them only while powered. */
function warningLight(value, powerStatus) {
  return powerStatus === 0 ? null : asBool(value);
}

function times10(value) {
  const parsed = asFloat(value);
  return parsed === null ? null : parsed * 10;
}

/** Map S05 MQTT parameter names into the international REST condition shape. */
function normalizeS05Params(params) {
  const latest = first(params, 'lastUpdatedTime', 'lastUpdatedAt', 'latestDate');
  const chargeStatus = asInt(params.ChrgSts);
  const [acCurrent, dcCurrent, activeCurrent] = chargeCurrents(
    first(params, 'BattACChrgInCurr', 'battACChrgInCurr'),
    first(params, 'BattDCChrgInCurr', 'battDCChrgInCurr'),
    chargeStatus,
  );
  const [chargeConStatus, acGun, dcGun] = chargeGunFlags(
    chargeStatus,
    params.acChargeGunConnectionState,
    first(params, 'dcDhargeGunConnectionState', 'dcChargeGunConnectionState'),
  );
  const powerStatus = asInt(params.powerStatusFeedBack);
  const remainChargeTime = asInt(params.chargDeltMins);
  const tire = (pressure, temperature, alarm) => ({
    pressure: asFloat(params[pressure]),
    temperature: asFloat(params[temperature]),
    alarm: asInt(params[alarm]),
  });
  const seat = (heat, vent) => ({
    heatStatus: seatLevel(params[heat]),
    ventStatus: seatLevel(params[vent]),
  });

  return {
    lastUpdatedAt: toMillis(latest),
    vehicleStatus: {
      soc: asInt(first(params, 'soc', 'socDsp', 'remainPower')),
      drvMileage: asInt(first(params, 'remainedPowerMile', 'totalResidualMileage')),
      totalMileage: asFloat(params.totalOdometer),
      totalMeterYesterday: asFloat(params.totalMeterYesterday),
      igniteCumulativeMileage: asFloat(params.igniteCumulativeMileage),
      engineSts: asInt(params.engineStatus),
      connectStatus: 1,
      powerStatus,
      epbSts: asInt(params.electronichandbrakeStatus),
    },
    hvac: {
      insideTemp: times10(params.vehicleTemperature),
      insideHumidity: asFloat(params.innerHumidity),
      remoteTemp: times10(params.airConditioningSetTemperature),
      acStatus: asInt(params.airStatus),
      defrostStatus: asInt(params.frontDefrostStatus),
      insideAirQualityLevel: asInt(params.airPurifierStatus),
      fanLevel: asInt(params.airConditioningHairRatings),
    },
    charge: {
      chargeStatus,
      chargeConStatus,
      acChargeGunConnectStatus: acGun,
      dcChargeGunConnectStatus: dcGun,
      acChargeCurrent: acCurrent,
      dcChargeCurrent: dcCurrent,
      chargeCurrent: activeCurrent,
      remainChargeTime: remainChargeTime === CHARGE_TIME_SENTINEL ? null : remainChargeTime,
    },
    fuel: {
      leftPercent: asInt(params.remainingFuel),
      remainingRange: asInt(params.remainedOilMile),
    },
    door: {
      doors: [
        asInt(params.driverDoor),
        asInt(params.passengerDoor),
        asInt(params.leftRearDoor),
        asInt(params.rightRearDoor),
      ],
      trunk: asInt(params.trunk),
      hood: asInt(first(params, 'hood', 'hoodStatus')),
      driverLock: asInt(params.driverDoorLock),
      passengerLock: asInt(params.passengerDoorLock),
    },
    window: {
      windows: [
        asInt(params.diverWindow),
        asInt(params.passengerWindow),
        asInt(params.leftRearWindow),
        asInt(params.rightRearWindow),
      ],
    },
    lamp: {
      highBeam: asInt(params.highBeam),
      lowBeam: asInt(params.lowBeam),
      positionLamp: asInt(params.positionLamp),
      frontFoglamp: asInt(params.frontFoglamp),
      rearFoglamp: asInt(params.rearFoglamp),
      leftTurn: asInt(params.turnLndicatorLeft),
      rightTurn: asInt(params.turnLndicatorRight),
    },
    warningLights: {
      battery12v: warningLight(params.batt12VLightStatus, powerStatus),
      tpms: warningLight(params.tpmsLightStatus, powerStatus),
      abs: warningLight(params.absLightStatus, powerStatus),
      brakeFluid: warningLight(params.brakeFluidLightStatus, powerStatus),
      brake: warningLight(params.brakeLightStatus, powerStatus),
      eps: warningLight(params.epsLightStatus, powerStatus),
      powerLimit: warningLight(params.powerLimitLightStatus, powerStatus),
      powerSystem: warningLight(params.powerSystemLightStatus, powerStatus),
      tractionBatteryLow: warningLight(params.bcuBattSocLightStatus, powerStatus),
    },
    keyBatteryLow: asBool(params.keyLowPower),
    tire: {
      leftFront: tire('lfTyrePressure', 'leftFrontTireTemperature', 'lfPressureWarning'),
      rightFront: tire('rfTyrePressure', 'rightFrontTireTemperature', 'rfPressureWarning'),
      leftBack: tire('lrTyrePressure', 'leftRearTireTemperature', 'lrPressureWarning'),
      rightBack: tire('rrTyrePressure', 'rightRearTireTemperature', 'rrPressureWarning'),
    },
    seat: {
      leftFront: seat('driverSeatHeatStatus', 'driverSeatAirStatus'),
      rightFront: seat('passengerSeatHeatStatus', 'passengerSeatAirStatus'),
      leftBack: seat('leftBackSeatHeatStatus', 'leftBackSeatVentilateStatus'),
      rightBack: seat('rightBackSeatHeatStatus', 'rightBackSeatVentilateStatus'),
    },
  };
}

function tenths(value) {
  const parsed = asFloat(value);
  return parsed === null ? null : parsed / 10;
}

function isOpen(value) {
  return value !== null && value !== undefined && value !== 0;
}

function lastUpdatedSeconds(raw, status) {
  const value = raw.lastUpdatedAt != null ? raw.lastUpdatedAt : status.lastUpdatedAt;
  if (value == null) return null;
  const millis = toMillis(value);
  // Accept both seconds and milliseconds.
  return millis > 1e12 ? Math.trunc(millis / 1000) : millis;
}

/**
 * Map a REST (or normalized MQTT) condition into the flat model the device uses.
 * Tri-state fields stay null when the car did not report them.
 */
function parseCondition(raw) {
  const status = raw.vehicleStatus || {};
  const charge = raw.charge || {};
  const hvac = raw.hvac || {};
  const door = raw.door || {};
  const window = raw.window || {};
  const fuel = raw.fuel || {};
  const tire = raw.tire || {};
  const doors = Array.isArray(door.doors) ? door.doors : [];
  const windows = Array.isArray(window.windows) ? window.windows : [];

  const chargingStatus = chargeState(charge.chargeStatus);
  let chargerConnected;
  if (charge.chargeStatus !== null && charge.chargeStatus !== undefined && asInt(charge.chargeStatus) !== 0) {
    chargerConnected = true;
  } else if (typeof charge.chargeConStatus === 'boolean') {
    chargerConnected = charge.chargeConStatus;
  } else {
    chargerConnected = gunCodeConnected(charge.chargeConStatus);
  }

  let locked = null;
  if (door.driverLock !== null && door.driverLock !== undefined) locked = asInt(door.driverLock) === 0;
  else if (door.passengerLock !== null && door.passengerLock !== undefined) locked = asInt(door.passengerLock) === 0;

  let humidity = asFloat(hvac.insideHumidity);
  humidity = humidity === null || humidity < 0 || humidity > 1000 ? null : humidity / 10;

  let remainingChargeTime = asInt(charge.remainChargeTime);
  if (remainingChargeTime === CHARGE_TIME_SENTINEL) remainingChargeTime = null;

  const tireStatus = position => {
    const data = tire[position] || {};
    const pressure = asFloat(data.pressure);
    return {
      pressureBar: pressure === null ? null : Math.round(pressure) / 100,
      temperatureC: asFloat(data.temperature),
      alarm: asInt(data.alarm != null ? data.alarm : data.status),
    };
  };

  return {
    lastUpdated: lastUpdatedSeconds(raw, status),
    socPercent: asInt(status.soc),
    rangeKm: asInt(status.drvMileage),
    odometerKm: asFloat(status.totalMileage),
    powerStatus: asInt(status.powerStatus),
    chargingStatus,
    charging: chargingStatus === null ? null : CHARGING_STATES.has(chargingStatus),
    chargerConnected,
    chargeCurrentA: cleanChargeCurrent(charge.chargeCurrent),
    remainingChargeTimeMin: remainingChargeTime,
    chargeLimitPercent: asInt(charge.maxSocPercent),
    climateOn: hvac.acStatus === null || hvac.acStatus === undefined ? null : asInt(hvac.acStatus) !== 0,
    targetTemperatureC: tenths(hvac.remoteTemp),
    insideTemperatureC: tenths(hvac.insideTemp),
    outsideTemperatureC: tenths(hvac.outsideTemp),
    humidityPercent: humidity,
    locked,
    doorsOpen: {
      driver: isOpen(doors[0]),
      passenger: isOpen(doors[1]),
      rearLeft: isOpen(doors[2]),
      rearRight: isOpen(doors[3]),
    },
    trunkOpen: isOpen(door.trunk),
    hoodOpen: isOpen(door.hood),
    windowsOpen: {
      frontLeft: isOpen(windows[0]),
      frontRight: isOpen(windows[1]),
      rearLeft: isOpen(windows[2]),
      rearRight: isOpen(windows[3]),
    },
    fuelPercent: asInt(fuel.leftPercent),
    tires: {
      frontLeft: tireStatus('leftFront'),
      frontRight: tireStatus('rightFront'),
      rearLeft: tireStatus('leftBack'),
      rearRight: tireStatus('rightBack'),
    },
    // Dashboard lights and key fob battery are only reported over S05 MQTT; null = not reported.
    warningLights: raw.warningLights || null,
    keyBatteryLow: raw.keyBatteryLow === undefined ? null : raw.keyBatteryLow,
    raw,
  };
}

module.exports = {
  CHARGE_TIME_SENTINEL,
  normalizeS05Params,
  parseCondition,
  chargeCurrents,
  chargeGunFlags,
};
