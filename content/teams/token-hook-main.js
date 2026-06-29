// Runs in page MAIN world — hooks network APIs before Teams loads (CSP-safe via manifest world: MAIN).
(function () {
  if (window.__khtTeamsHookInstalled) return;
  window.__khtTeamsHookInstalled = true;

  const MSG = 'KHT_TEAMS_TOKEN';

  function extractToken(authValue) {
    if (!authValue) return null;
    const s = String(authValue);
    const skype = s.match(/skypetoken=([^\s,;]+)/i);
    if (skype?.[1]) return skype[1];
    return null;
  }

  function emit(authValue) {
    const token = extractToken(authValue);
    if (token) window.postMessage({ type: MSG, token }, '*');
  }

  function scanHeaders(headers) {
    if (!headers) return;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, name) => {
          if (String(name).toLowerCase() === 'authentication') emit(value);
        });
        return;
      }
      if (Array.isArray(headers)) {
        headers.forEach(([name, value]) => {
          if (String(name).toLowerCase() === 'authentication') emit(value);
        });
        return;
      }
      Object.entries(headers).forEach(([name, value]) => {
        if (String(name).toLowerCase() === 'authentication') emit(value);
      });
    } catch (e) {
      /* ignore */
    }
  }

  if (typeof Headers !== 'undefined') {
    const origSet = Headers.prototype.set;
    const origAppend = Headers.prototype.append;
    Headers.prototype.set = function (name, value) {
      if (String(name).toLowerCase() === 'authentication') emit(value);
      return origSet.call(this, name, value);
    };
    Headers.prototype.append = function (name, value) {
      if (String(name).toLowerCase() === 'authentication') emit(value);
      return origAppend.call(this, name, value);
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'authentication') emit(value);
      return origSetHeader.apply(this, arguments);
    };
  }

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      scanHeaders(init?.headers);
      if (typeof Request !== 'undefined' && input instanceof Request) {
        scanHeaders(input.headers);
      }
      return origFetch.apply(this, arguments);
    };
  }
})();
