// ISOLATED world — forwards tokens captured in page MAIN world to the extension background.
(function () {
  const MSG = "KHT_TEAMS_TOKEN";
  const bridgeLog =
    typeof createLogger === "function"
      ? createLogger("[Teams Bridge]")
      : { log() {}, warn() {} };

  function teamsBridgeLog(...args) {
    if (typeof TEAMS_CAPTURE_LOGGING !== "undefined" && TEAMS_CAPTURE_LOGGING) {
      // console.log('[Teams Bridge]', ...args);
    }
  }

  teamsBridgeLog("content script loaded on", location.href);

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.type !== MSG ||
      !event.data.token
    )
      return;
    const preview =
      event.data.token.length > 20
        ? `${event.data.token.slice(0, 12)}…`
        : "(short)";
    teamsBridgeLog("token from page hook → background", preview);
    chrome.runtime
      .sendMessage({
        type: "TEAMS_TOKEN_CAPTURED",
        token: event.data.token,
      })
      .then(() => {
        teamsBridgeLog("background acknowledged token");
      })
      .catch((err) => {
        teamsBridgeLog("sendMessage failed", err?.message || err);
        bridgeLog.warn("sendMessage failed", err?.message || err);
      });
  });
})();
