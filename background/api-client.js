// Thin HTTP client for Vercel API

const API_LOG = "[API]";

async function getKekaToken() {
  const { kekaAuthToken } = await chrome.storage.local.get({
    kekaAuthToken: "",
  });
  return kekaAuthToken || null;
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
    };
  }

  const manifest = chrome.runtime.getManifest();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Extension-Version": manifest.version,
    ...(options.headers || {}),
  };

  console.log("API_BASE_URL", API_BASE_URL);
  console.log("path", path);
  console.log("headers", headers);
  console.log("options.body", options.body);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.warn(API_LOG, path, response.status, data.error);
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        status: response.status,
      };
    }
    console.log("data", data);
    return { success: true, ...data };
  } catch (err) {
    console.warn(API_LOG, path, err.message);
    return { success: false, error: err.message };
  }
}

async function apiRegister() {
  const manifest = chrome.runtime.getManifest();
  return apiFetch("/api/v1/auth/register", {
    method: "POST",
    body: { extensionVersion: manifest.version },
  });
}

async function apiSyncKekaToken(source) {
  const token = await getKekaToken();
  if (!token) return { success: false };
  await apiRegister();
  return apiFetch("/api/v1/credentials/keka", {
    method: "POST",
    body: { token, source: source || "extension" },
  });
}

async function apiSyncWorkspaceSession(csrfToken, cookies) {
  await apiRegister();
  return apiFetch("/api/v1/credentials/workspace", {
    method: "POST",
    body: { csrfToken, cookies },
  });
}

async function apiSyncTeamsCredentials(creds) {
  await apiRegister();
  return apiFetch("/api/v1/credentials/teams", {
    method: "POST",
    body: creds,
  });
}

async function apiGetAttendanceToday() {
  await apiRegister();
  return apiFetch("/api/v1/attendance/today");
}

async function apiSyncAttendance(rawApiItems) {
  await apiRegister();
  return apiFetch("/api/v1/attendance/sync", {
    method: "POST",
    body: rawApiItems ? { rawApiItems } : {},
  });
}

async function apiGetWorkspaceStatus() {
  await apiRegister();
  return apiFetch("/api/v1/workspace/status");
}

async function apiStartWorkspaceTimer(taskId, note) {
  await apiRegister();
  return apiFetch("/api/v1/workspace/timer/start", {
    method: "POST",
    body: { taskId, note: note || "" },
  });
}

async function apiCheckAlerts(options) {
  await apiRegister();
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
  await apiRegister();
  return apiFetch("/api/v1/alerts/check", {
    method: "POST",
    body: { test: true, language: language || "en" },
  });
}

async function apiSendTeamsMessage(message) {
  await apiRegister();
  return apiFetch("/api/v1/eod/send", {
    method: "POST",
    body: { message },
  });
}

async function apiGetEodSuggestion() {
  await apiRegister();
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
    console.warn(API_LOG, "workspace sync skipped — no CSRF/session cookies");
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
    console.warn(
      API_LOG,
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
    return { success: false, error: "Missing workspace session cookie (sp_session)" };
  }

  const result = await apiSyncWorkspaceSession(
    session.csrfToken,
    session.cookies,
  );

  if (result.success) {
    console.log(API_LOG, "workspace session synced to API");
    await chrome.storage.local.set({
      lastWorkspaceSessionSync: {
        status: "success",
        at: new Date().toISOString(),
        cookieNames: Object.keys(session.cookies),
      },
    });
  } else {
    console.warn(API_LOG, "workspace session sync failed", result.error);
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
    console.log(API_LOG, "teams credentials synced");
  }
}
