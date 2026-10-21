'use strict';

const Homey = require('homey');

class VehicleDriver extends Homey.Driver {

  async onInit() {
    this.chargingStartedTrigger = this.homey.flow.getDeviceTriggerCard('charging_started');
    this.chargingStoppedTrigger = this.homey.flow.getDeviceTriggerCard('charging_stopped');
  }

  /**
   * Pairing: login (email or SMS code) -> list_devices -> add_devices.
   * When the app already holds a session, the login view skips itself.
   */
  async onPair(session) {
    this._registerLoginHandlers(session, 'pair');

    session.setHandler('list_devices', async () => {
      const vehicles = await this.homey.app.getClient().getVehicles();
      return vehicles.map(vehicle => ({
        name: vehicle.nickName || [vehicle.seriesName, vehicle.modelName].filter(Boolean).join(' ') || 'Deepal',
        data: { id: vehicle.carId },
        store: {
          vin: vehicle.vin,
          protocolType: vehicle.protocolType,
          seriesCode: vehicle.seriesCode,
          licensePlate: vehicle.licensePlate,
        },
      }));
    });
  }

  /** Repair always shows the login, so an invalidated session can be replaced. */
  async onRepair(session, device) {
    this._registerLoginHandlers(session, 'repair', device);
  }

  _registerLoginHandlers(session, mode, device = null) {
    let loginClient = null;
    let loginTarget = null;

    session.setHandler('get_mode', async () => ({
      mode,
      loggedIn: Boolean(this.homey.app.client && this.homey.app.client.isLoggedIn),
    }));

    session.setHandler('request_code', async ({
      method, email, phone, dialCode, country, environment,
    }) => {
      loginClient = this.homey.app.createLoginClient({
        country: String(country || 'GB').toUpperCase(),
        language: 'en_US',
        environment: environment || 'release_eu',
      });
      loginTarget = { method, email, phone, dialCode };
      if (method === 'sms') await loginClient.requestSmsCode(phone, dialCode);
      else await loginClient.requestEmailCode(email);
      return true;
    });

    session.setHandler('login', async ({ code }) => {
      if (!loginClient || !loginTarget) throw new Error(this.homey.__('pair.request_code_first'));
      if (loginTarget.method === 'sms') {
        await loginClient.loginWithSmsCode(loginTarget.phone, code, loginTarget.dialCode);
      } else {
        await loginClient.loginWithEmailCode(loginTarget.email, code);
      }
      this.homey.app.adoptClient(loginClient);
      if (device) {
        await device.setAvailable().catch(this.error);
        device.poll();
      }
      return true;
    });
  }

}

module.exports = VehicleDriver;
