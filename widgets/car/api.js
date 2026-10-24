'use strict';

module.exports = {
  async getState({ homey }) {
    return homey.app.getWidgetState();
  },

  async command({ homey, body }) {
    return homey.app.runWidgetCommand(body || {});
  },
};
