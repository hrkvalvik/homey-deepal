'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeS05Params, parseCondition } = require('../lib/condition');

test('S05 MQTT parameters map into the shared model', () => {
  const condition = parseCondition(normalizeS05Params({
    lastUpdatedTime: '2026-09-18T10:00:00Z',
    soc: 63,
    remainedPowerMile: 210,
    totalOdometer: 18300,
    airConditioningSetTemperature: 22.5,
    airStatus: 1,
    vehicleTemperature: 21.5,
    innerHumidity: 444,
    ChrgSts: 3,
    BattACChrgInCurr: 16.2,
    BattDCChrgInCurr: 2538,
    chargDeltMins: 95,
    driverDoor: 1,
    trunk: 0,
    driverDoorLock: 0,
    diverWindow: 0,
    lfTyrePressure: 240,
    passengerSeatHeatStatus: 6,
  }));
  assert.strictEqual(condition.lastUpdated, 1789725600);
  assert.strictEqual(condition.socPercent, 63);
  assert.strictEqual(condition.rangeKm, 210);
  assert.strictEqual(condition.targetTemperatureC, 22.5);
  assert.strictEqual(condition.insideTemperatureC, 21.5);
  assert.strictEqual(condition.humidityPercent, 44.4);
  assert.strictEqual(condition.climateOn, true);
  assert.strictEqual(condition.charging, true);
  assert.strictEqual(condition.chargerConnected, true);
  assert.strictEqual(condition.chargeCurrentA, 16.2);
  assert.strictEqual(condition.remainingChargeTimeMin, 95);
  assert.strictEqual(condition.locked, true);
  assert.strictEqual(condition.doorsOpen.driver, true);
  assert.strictEqual(condition.trunkOpen, false);
  assert.strictEqual(condition.tires.frontLeft.pressureBar, 2.4);
  assert.strictEqual(condition.raw.seat.rightFront.heatStatus, null, 'sleep sentinel 6 is unknown');
});

test('REST condition: sentinel charge time, unplugged car and unknown climate', () => {
  const condition = parseCondition({
    vehicleStatus: { soc: 82, drvMileage: 410, totalMileage: 12450 },
    charge: { chargeStatus: 0, chargeConStatus: 0, remainChargeTime: 8191 },
    door: { doors: [0, 0, 0, 0], driverLock: 1 },
    hvac: { remoteTemp: 220, outsideTemp: 85 },
  });
  assert.strictEqual(condition.remainingChargeTimeMin, null);
  assert.strictEqual(condition.charging, false);
  assert.strictEqual(condition.chargerConnected, false);
  assert.strictEqual(condition.locked, false);
  assert.strictEqual(condition.climateOn, null);
  assert.strictEqual(condition.outsideTemperatureC, 8.5);
});

test('S05 warning lights and key battery are reported only while the car is on', () => {
  const on = parseCondition(normalizeS05Params({ powerStatusFeedBack: 2, absLightStatus: 1, tpmsLightStatus: 0, keyLowPower: 1, rrPressureWarning: 1 }));
  assert.strictEqual(on.warningLights.abs, true);
  assert.strictEqual(on.warningLights.tpms, false);
  assert.strictEqual(on.warningLights.brake, null, 'not reported stays unknown');
  assert.strictEqual(on.keyBatteryLow, true);
  assert.strictEqual(on.tires.rearRight.alarm, 1);

  const off = parseCondition(normalizeS05Params({ powerStatusFeedBack: 0, absLightStatus: 1 }));
  assert.strictEqual(off.warningLights.abs, null, 'a sleeping car reports healthy bits as 1');

  const rest = parseCondition({ tire: { leftFront: { pressure: 250, status: 0 } } });
  assert.strictEqual(rest.warningLights, null);
  assert.strictEqual(rest.keyBatteryLow, null);
  assert.strictEqual(rest.tires.frontLeft.pressureBar, 2.5);
});
