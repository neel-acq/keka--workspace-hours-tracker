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

async function collectWorkspaceCookiesForApi() {
  const origin = "https://workspace.acquaintsoft.com";
  const urls = [`${origin}/`, `${origin}/admin/`];
  const cookies = {};
  for (const url of urls) {
    const list = await chrome.cookies.getAll({ url });
    list.forEach((c) => {
      cookies[c.name] = c.value;
    });
  }
  const csrf = cookies.csrf_cookie_name || cookies.csrf_token_name;
  if (!csrf) return null;
  return { csrfToken: csrf, cookies };
}

async function syncWorkspaceCredentialsToApi() {
  if (!API_ENABLED) return;
  const session = await collectWorkspaceCookiesForApi();
  if (!session) return;
  const result = await apiSyncWorkspaceSession(
    session.csrfToken,
    session.cookies,
  );
  if (result.success) {
    console.log(API_LOG, "workspace credentials synced");
  }
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
