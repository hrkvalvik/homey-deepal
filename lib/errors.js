'use strict';

/**
 * Error taxonomy mirroring deepal_sdk/deepal/exceptions.py, so the device code
 * can tell a dead session (re-pair) from a transient failure (retry later).
 */
class DeepalError extends Error {
  constructor(message, { code = null, statusCode = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

class DeepalConnectionError extends DeepalError {}
class DeepalAPIError extends DeepalError {}
class DeepalAuthError extends DeepalError {}
class DeepalSessionInvalidated extends DeepalAuthError {}
class DeepalRateLimitError extends DeepalAPIError {}
class DeepalCommandAuthError extends DeepalAPIError {}
class DeepalCommandNotReady extends DeepalError {}

module.exports = {
  DeepalError,
  DeepalConnectionError,
  DeepalAPIError,
  DeepalAuthError,
  DeepalSessionInvalidated,
  DeepalRateLimitError,
  DeepalCommandAuthError,
  DeepalCommandNotReady,
};
