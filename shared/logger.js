// Central log/warn/error helpers — load after config.js (DEBUG_LOGGING).

function isDebugLoggingEnabled() {
  return typeof DEBUG_LOGGING !== "undefined" && !!DEBUG_LOGGING;
}

function createLogger(namespace) {
  function log(...args) {
    if (isDebugLoggingEnabled()) console.log(namespace, ...args);
  }

  function warn(...args) {
    if (isDebugLoggingEnabled()) console.warn(namespace, ...args);
  }

  function error(...args) {
    if (isDebugLoggingEnabled()) console.error(namespace, ...args);
  }

  return { log, warn, error };
}
