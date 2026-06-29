// Thin HTTP client for Vercel API

const API_LOG = "[API]";

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
      console.warn(API_LOG, path, response.status, data.error);
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        status: response.status,
      };
    }
    return { success: true, ...data };
  } catch (err) {
    console.warn(API_LOG, path, err.message);
    return { success: false, error: err.message };
  }
}

async function apiRegister() {
  const manifest = chrome.runtime.getManifest();
  const profile = await fetchKekaContextProfileDirect();

  const result = await apiFetch("/api/v1/auth/register", {
    method: "POST",
    body: {
      extensionVersion: manifest.version,
      display_name: profile?.display_name || undefined,
      company_name: profile?.company_name || undefined,
    },
  });

  if (profile) {
    await applyKekaProfileToStorage(
      profile.display_name,
      profile.company_name,
    );
  } else if (result.success && result.user) {
    await applyKekaProfileToStorage(
      result.user.display_name,
      result.user.company_name,
    );
  }
  return result;
}

function decodeKekaJwtPayload(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

function getKekaSubdomainFromToken(token) {
  const payload = decodeKekaJwtPayload(token);
  if (!payload) return null;
  if (payload.subdomain) return payload.subdomain;
  const iss = payload.iss || "";
  const match = String(iss).match(/https?:\/\/([^.]+)\.keka\.com/i);
  return match ? match[1].toLowerCase() : null;
}

async function fetchKekaContextProfileDirect() {
  const token = await getKekaToken();
  if (!token) return null;

  const subdomain = getKekaSubdomainFromToken(token) || "acquaint";
  try {
    const response = await fetch(
      `https://${subdomain}.keka.com/k/dashboard/api/context`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    const root = data?.data;
    if (!root) return null;
    return {
      display_name: root.employee?.displayName || null,
      company_name: root.org?.name || root.org?.shortName || null,
    };
  } catch {
    return null;
  }
}

async function applyKekaProfileToStorage(displayName, companyName) {
  const updates = {};
  if (displayName) {
    updates.teamsDisplayName = displayName;
    updates.kekaDisplayName = displayName;
  }
  if (companyName) updates.kekaCompanyName = companyName;
  if (!Object.keys(updates).length) return;

  await chrome.storage.local.set(updates);
  console.log(API_LOG, "Keka profile:", displayName, "|", companyName);

  const { teamsSkypeToken } = await chrome.storage.local.get("teamsSkypeToken");
  if (teamsSkypeToken) {
    await syncTeamsCredentialsToApi();
  }
}

async function syncKekaProfileFromContext() {
  if (!API_ENABLED || !(await getKekaToken())) {
    const profile = await fetchKekaContextProfileDirect();
    if (profile) {
      await applyKekaProfileToStorage(
        profile.display_name,
        profile.company_name,
      );
    }
    return;
  }

  await apiRegister();
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
    console.log(
      API_LOG,
      "workspace session saved locally — open Keka to sync to cloud",
    );
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
    console.log(API_LOG, "workspace session synced to API");
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

  console.log(API_LOG, "flushing pending workspace session to API");
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
    console.log(API_LOG, "teams credentials synced");
  }
}
