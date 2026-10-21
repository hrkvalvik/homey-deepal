'use strict';

const Homey = require('homey');
const DeepalClient = require('./lib/DeepalClient');

/**
 * Holds the single My Changan account session shared by every paired vehicle.
 * One session per account matters: each login can sign out the others.
 */
class DeepalApp extends Homey.App {

  async onInit() {
    const session = this.homey.settings.get('session');
    this.client = session ? this._createClient(session) : null;
    this._registerFlowCards();
    this.log('Deepal app initialized', this.client ? '(session restored)' : '(not logged in)');
  }

  _createClient(session) {
    return new DeepalClient({
      country: session.country,
      language: session.language,
      environment: session.environment,
      session,
      onSessionChange: updated => this.homey.settings.set('session', updated),
      log: (...args) => this.log(...args),
    });
  }

  /** A client for a new login during pairing. It replaces the account session once the login succeeds. */
  createLoginClient({ country, language, environment }) {
    const previous = this.homey.settings.get('session') || {};
    // Reuse the device id and signing key so the account sees a stable device.
    const session = {
      deviceId: previous.deviceId,
      privateKeyPem: previous.privateKeyPem,
      publicKey: previous.publicKey,
      country,
      language,
      environment,
    };
    return this._createClient(session);
  }

  adoptClient(client) {
    this.client = client;
    this.homey.settings.set('session', client.getSession());
  }

  getClient() {
    if (!this.client || !this.client.isLoggedIn) {
      throw new Error(this.homey.__('errors.not_logged_in'));
    }
    return this.client;
  }

  _registerFlowCards() {
    const run = method => async (args, state) => args.device[method](args, state);

    this.homey.flow.getActionCard('climate_on').registerRunListener(run('flowClimateOn'));
    this.homey.flow.getActionCard('climate_off').registerRunListener(run('flowClimateOff'));
    this.homey.flow.getActionCard('flash_lights').registerRunListener(run('flowFlash'));
    this.homey.flow.getActionCard('sound_horn').registerRunListener(run('flowHorn'));
    this.homey.flow.getActionCard('flash_and_horn').registerRunListener(run('flowFlashAndHorn'));
    this.homey.flow.getActionCard('open_trunk').registerRunListener(run('flowOpenTrunk'));
    this.homey.flow.getActionCard('set_windows').registerRunListener(run('flowSetWindows'));
    this.homey.flow.getActionCard('set_charge_limit').registerRunListener(run('flowSetChargeLimit'));
    this.homey.flow.getActionCard('wake_and_refresh').registerRunListener(run('flowWakeAndRefresh'));

    this.homey.flow.getConditionCard('is_charging').registerRunListener(async args => args.device.getCapabilityValue('ev_charging_state') === 'plugged_in_charging');
    this.homey.flow.getConditionCard('is_plugged_in').registerRunListener(async args => {
      const state = args.device.getCapabilityValue('ev_charging_state');
      return Boolean(state) && state !== 'plugged_out';
    });
  }

}

module.exports = DeepalApp;
