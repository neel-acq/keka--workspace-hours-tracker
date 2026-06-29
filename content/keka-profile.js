// Fetch Keka dashboard context from the page (same-origin; MV3-safe).

(function initKekaProfileCapture() {
  if (!window.location.hostname.endsWith(".keka.com")) return;

  let captured = false;

  async function captureKekaProfile() {
    if (captured) return;

    try {
      const { kekaAuthToken } = await chrome.storage.local.get("kekaAuthToken");
      if (!kekaAuthToken) return;

      const response = await fetch("/k/dashboard/api/context", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${kekaAuthToken}`,
          Accept: "application/json",
        },
        credentials: "include",
      });
      if (!response.ok) return;

      const data = await response.json();
      const profile = parseKekaContextPayload(data);
      if (!profile) return;

      captured = true;
      chrome.runtime.sendMessage({
        type: "KEKA_PROFILE_CAPTURED",
        profile,
      });
    } catch {
      // ignore
    }
  }

  function scheduleRetries() {
    captureKekaProfile();
    setTimeout(captureKekaProfile, 3000);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CAPTURE_KEKA_PROFILE") {
      captureKekaProfile();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.kekaAuthToken?.newValue && !captured) {
      setTimeout(captureKekaProfile, 1000);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(scheduleRetries, 1000);
    });
  } else {
    setTimeout(scheduleRetries, 1000);
  }
})();
