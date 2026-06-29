// Thin HTTP client for Vercel API

const apiLog = createLogger("[API]");

async function getKekaToken() {
  const { kekaAuthToken } = await chrome.storage.local.get({
    kekaAuthToken: "",
  });
  return kekaAuthToken || null;
}

async function hasKekaTokenForApi() {
  if (!API_ENABLED) return false;
  return !!(await getKekaToken());
}

async function getStoredKekaProfile() {
  const { kekaDisplayName, kekaCompanyName } = await chrome.storage.local.get({
    kekaDisplayName: "",
    kekaCompanyName: "",
  });
  if (!kekaDisplayName && !kekaCompanyName) return null;
  return {
    display_name: kekaDisplayName || null,
    company_name: kekaCompanyName || null,
  };
}

const REGISTER_TTL_MS = 5 * 60 * 1000;
const PROFILE_SYNC_TTL_MS = 30 * 60 * 1000;

let lastRegisterAt = 0;
let registerInFlight = null;
let lastProfileSyncKey = "";
let lastProfileSyncAt = 0;
let profileSyncInFlight = null;

function profileSyncKey(profile) {
  return `${profile?.display_name || ""}|${profile?.company_name || ""}`;
}

async function apiFetch(path, options = {}) {
  if (!API_ENABLED) {
    return {
      success: false,
      error: "API not configured. Set API_BASE_URL in config.js",
    };
  }

  const token = await getKekaToken();
  if (!token) {
    return {
      success: false,
      error: "No Keka token. Visit Keka to capture token.",
      reason: "no_keka_token",
    };
  }

  const manifest = chrome.runtime.getManifest();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Extension-Version": manifest.version,
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      apiLog.warn(path, response.status, data.error);
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        status: response.status,
      };
    }
    return { success: true, ...data };
  } catch (err) {
    apiLog.warn(path, err.message);
    return { success: false, error: err.message };
  }
}

async function ensureApiSession({ force = false } = {}) {
  if (!API_ENABLED) {
    return { success: false, error: "API not configured" };
  }

  const now = Date.now();
  if (!force && now - lastRegisterAt < REGISTER_TTL_MS) {
    return { success: true, cached: true };
  }

  if (registerInFlight) return registerInFlight;

  registerInFlight = (async () => {
    try {
      const manifest = chrome.runtime.getManifest();
      const storedProfile = await getStoredKekaProfile();
      const result = await apiFetch("/api/v1/auth/register", {
        method: "POST",
        body: {
          extensionVersion: manifest.version,
          display_name: storedProfile?.display_name || undefined,
          company_name: storedProfile?.company_name || undefined,
        },
      });
      if (result.success) lastRegisterAt = Date.now();
      return result;
    } finally {
      registerInFlight = null;
    }
  })();

  return registerInFlight;
}

async function apiRegister() {
  return ensureApiSession({ force: true });
}

async function fetchKekaContextProfileDirect() {
  const token = await getKekaToken();
  if (!token) return null;

  const base = kekaTenantBaseUrl(getKekaSubdomainFromToken(token));
  try {
    const response = await fetch(`${base}/k/dashboard/api/context`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: `${base}/`,
      },
    });
    if (!response.ok) {
      apiLog.warn("Keka context fetch failed", response.status);
      return null;
    }
    const data = await response.json();
    return parseKekaContextPayload(data);
  } catch (err) {
    apiLog.warn("Keka context fetch error", err.message);
    return null;
  }
}

async function syncKekaProfileToApiOnce(profile) {
  if (!API_ENABLED) return { success: false, skipped: true };

  const payload = profile || (await getStoredKekaProfile());
  if (!payload?.display_name && !payload?.company_name) {
    return { success: false, skipped: true };
  }

  const key = profileSyncKey(payload);
  const now = Date.now();
  if (key === lastProfileSyncKey && now - lastProfileSyncAt < PROFILE_SYNC_TTL_MS) {
    return { success: true, cached: true };
  }

  if (profileSyncInFlight) return profileSyncInFlight;

  profileSyncInFlight = (async () => {
    try {
      await ensureApiSession();
      const result = await apiFetch("/api/v1/user/profile", {
        method: "POST",
        body: {
          display_name: payload.display_name || undefined,
          company_name: payload.company_name || undefined,
        },
      });
      if (result.success) {
        lastProfileSyncKey = key;
        lastProfileSyncAt = Date.now();
      }
      return result;
    } finally {
      profileSyncInFlight = null;
    }
  })();

  return profileSyncInFlight;
}

async function saveKekaProfileLocally(displayName, companyName) {
  const { kekaDisplayName, kekaCompanyName } = await chrome.storage.local.get({
    kekaDisplayName: "",
    kekaCompanyName: "",
  });

  if (
    displayName === kekaDisplayName &&
    companyName === kekaCompanyName
  ) {
    return false;
  }

  const updates = {};
  if (displayName) {
    updates.teamsDisplayName = displayName;
    updates.kekaDisplayName = displayName;
  }
  if (companyName) updates.kekaCompanyName = companyName;
  if (!Object.keys(updates).length) return false;

  await chrome.storage.local.set(updates);
  apiLog.log("Keka profile saved:", displayName, "|", companyName);
  return true;
}

async function applyKekaProfileToStorage(displayName, companyName) {
  if (!displayName && !companyName) return;

  await saveKekaProfileLocally(displayName, companyName);
  await syncKekaProfileToApiOnce({
    display_name: displayName || null,
    company_name: companyName || null,
  });
}

let profileContextSyncInFlight = null;

async function syncKekaProfileFromContext() {
  if (profileContextSyncInFlight) return profileContextSyncInFlight;

  profileContextSyncInFlight = (async () => {
    try {
      const profile = await fetchKekaContextProfileDirect();
      if (!profile) return;
      await applyKekaProfileToStorage(
        profile.display_name,
        profile.company_name,
      );
    } finally {
      profileContextSyncInFlight = null;
    }
  })();

  return profileContextSyncInFlight;
}

async function apiSyncKekaToken(source) {
  const token = await getKekaToken();
  if (!token) return { success: false };
  await ensureApiSession({ force: true });
  return apiFetch("/api/v1/credentials/keka", {
    method: "POST",
    body: { token, source: source || "extension" },
  });
}

async function apiSyncWorkspaceSession(csrfToken, cookies) {
  await ensureApiSession();
  return apiFetch("/api/v1/credentials/workspace", {
    method: "POST",
    body: { csrfToken, cookies },
  });
}

async function apiSyncTeamsCredentials(creds) {
  await ensureApiSession();
  return apiFetch("/api/v1/credentials/teams", {
    method: "POST",
    body: creds,
  });
}

async function apiGetAttendanceToday() {
  await ensureApiSession();
  return apiFetch("/api/v1/attendance/today");
}

async function apiSyncAttendance(rawApiItems) {
  await ensureApiSession();
  return apiFetch("/api/v1/attendance/sync", {
    method: "POST",
    body: rawApiItems ? { rawApiItems } : {},
  });
}

async function apiGetWorkspaceStatus() {
  await ensureApiSession();
  return apiFetch("/api/v1/workspace/status");
}

async function apiStartWorkspaceTimer(taskId, note) {
  await ensureApiSession();
  return apiFetch("/api/v1/workspace/timer/start", {
    method: "POST",
    body: { taskId, note: note || "" },
  });
}

async function apiCheckAlerts(options) {
  await ensureApiSession();
  const params = new URLSearchParams();
  if (options.language) params.set("language", options.language);
  if (options.notificationsEnabled === false)
    params.set("notificationsEnabled", "false");
  if (options.workspaceAlertsEnabled === false)
    params.set("workspaceAlertsEnabled", "false");
  if (options.workspaceAlertInterval)
    params.set(
      "workspaceAlertInterval",
      String(options.workspaceAlertInterval),
    );
  if (options.scrapedAttendance) {
    params.set("attendance", JSON.stringify(options.scrapedAttendance));
  }
  const qs = params.toString();
  return apiFetch(`/api/v1/alerts/check${qs ? `?${qs}` : ""}`);
}

async function apiTestAlert(language) {
  await ensureApiSession();
  return apiFetch("/api/v1/alerts/check", {
    method: "POST",
    body: { test: true, language: language || "en" },
  });
}

async function apiSendTeamsMessage(message) {
  await ensureApiSession();
  return apiFetch("/api/v1/eod/send", {
    method: "POST",
    body: { message },
  });
}

async function apiGetEodSuggestion() {
  await ensureApiSession();
  return apiFetch("/api/v1/eod/suggestion");
}

function getCookieForApi(url, name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url, name }, (cookie) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(cookie || null);
    });
  });
}

function getAllCookiesForApi(url) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url }, (cookies) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(cookies || []);
    });
  });
}

async function collectWorkspaceCookiesForApi() {
  const origin = "https://workspace.acquaintsoft.com";
  const urls = [
    `${origin}/`,
    `${origin}/admin/`,
    `${origin}/admin/staff/timesheets`,
    `${origin}/admin/tasks`,
  ];

  const [directCsrf, directSession, ...urlCookieSets] = await Promise.all([
    getCookieForApi(`${origin}/`, "csrf_cookie_name"),
    getCookieForApi(`${origin}/`, "sp_session"),
    ...urls.map((url) => getAllCookiesForApi(url)),
  ]);

  const seen = new Set();
  const cookies = {};

  const addCookie = (cookie) => {
    if (!cookie?.name) return;
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    cookies[cookie.name] = cookie.value;
  };

  [directCsrf, directSession].filter(Boolean).forEach(addCookie);
  urlCookieSets.flat().forEach(addCookie);

  const csrfToken = cookies.csrf_cookie_name || cookies.csrf_token_name;
  if (!csrfToken) return null;

  return { csrfToken, cookies };
}

async function syncWorkspaceCredentialsToApi(sessionOverride) {
  if (!API_ENABLED) {
    return { success: false, skipped: true, error: "API disabled" };
  }

  const session = sessionOverride || (await collectWorkspaceCookiesForApi());
  if (!session?.csrfToken || !session?.cookies) {
    apiLog.warn("workspace sync skipped — no CSRF/session cookies");
    await chrome.storage.local.set({
      lastWorkspaceSessionSync: {
        status: "skipped",
        error: "No workspace CSRF cookie found. Open Workspace and log in.",
        at: new Date().toISOString(),
      },
    });
    return { success: false, error: "No workspace session cookies" };
  }

  const hasSessionCookie = !!(
    session.cookies.sp_session || session.cookies.ci_session
  );
  if (!hasSessionCookie) {
    apiLog.warn(
      "workspace sync skipped — missing sp_session/ci_session",
      Object.keys(session.cookies),
    );
    await chrome.storage.local.set({
      lastWorkspaceSessionSync: {
        status: "skipped",
        error: "Missing sp_session. Open Workspace in Chrome and log in.",
        at: new Date().toISOString(),
        cookieNames: Object.keys(session.cookies),
      },
    });
    return {
      success: false,
      error: "Missing workspace session cookie (sp_session)",
    };
  }

  const kekaToken = await getKekaToken();
  if (!kekaToken) {
    await chrome.storage.local.set({
      pendingWorkspaceSession: {
        csrfToken: session.csrfToken,
        cookies: session.cookies,
        at: new Date().toISOString(),
      },
      lastWorkspaceSessionSync: {
        status: "pending",
        error:
          "Visit Keka once to link your account — workspace session will sync after that.",
        at: new Date().toISOString(),
        cookieNames: Object.keys(session.cookies),
      },
    });
    apiLog.log("workspace session saved locally — open Keka to sync to cloud");
    return {
      success: false,
      skipped: true,
      reason: "no_keka_token",
      pending: true,
    };
  }

  const result = await apiSyncWorkspaceSession(
    session.csrfToken,
    session.cookies,
  );

  if (result.success) {
    apiLog.log("workspace session synced to API");
    await chrome.storage.local.remove("pendingWorkspaceSession");
    await chrome.storage.local.set({
      lastWorkspaceSessionSync: {
        status: "success",
        at: new Date().toISOString(),
        cookieNames: Object.keys(session.cookies),
      },
    });
  } else if (result.reason === "no_keka_token") {
    // already queued — no error log
  } else {
    apiLog.warn("workspace session sync failed", result.error);
    await chrome.storage.local.set({
      lastWorkspaceSessionSync: {
        status: "error",
        error: result.error,
        at: new Date().toISOString(),
        cookieNames: Object.keys(session.cookies),
      },
    });
  }

  return result;
}

async function flushPendingWorkspaceSessionSync() {
  if (!API_ENABLED) return { success: false, skipped: true };

  const token = await getKekaToken();
  if (!token) return { success: false, reason: "no_keka_token" };

  const { pendingWorkspaceSession } = await chrome.storage.local.get(
    "pendingWorkspaceSession",
  );
  if (!pendingWorkspaceSession?.csrfToken || !pendingWorkspaceSession?.cookies) {
    return { success: false, skipped: true, reason: "no_pending_session" };
  }

  apiLog.log("flushing pending workspace session to API");
  return syncWorkspaceCredentialsToApi({
    csrfToken: pendingWorkspaceSession.csrfToken,
    cookies: pendingWorkspaceSession.cookies,
  });
}

async function syncTeamsCredentialsToApi() {
  if (!API_ENABLED) return;
  const data = await chrome.storage.local.get([
    "teamsSkypeToken",
    "teamsTokenExpiry",
    "teamsFromId",
    "teamsDisplayName",
    "teamsConversationId",
    "teamsPrewrittenMessages",
  ]);
  if (!data.teamsSkypeToken) return;
  const result = await apiSyncTeamsCredentials({
    skypeToken: data.teamsSkypeToken,
    tokenExpiry: data.teamsTokenExpiry
      ? new Date(data.teamsTokenExpiry).toISOString()
      : null,
    fromId: data.teamsFromId,
    displayName: data.teamsDisplayName,
    conversationId: data.teamsConversationId,
    prewrittenMessages: data.teamsPrewrittenMessages,
  });
  if (result.success) {
    apiLog.log("teams credentials synced");
  }
}
