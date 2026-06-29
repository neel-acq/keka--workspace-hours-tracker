// Workspace / EOD tab logic

const wsUiLog = createLogger("[Workspace UI]");

const DEFAULT_EOD_MESSAGES = [
  "Good Morning.",
  "Going For Break.",
  "Back from Break.",
  "Leaving for the day",
  "Done for today, see you tomorrow!",
];

let workspaceInitialized = false;
let timesheetElapsedInterval = null;

function initWorkspacePage() {
  if (!workspaceInitialized) {
    bindWorkspaceEvents();
    workspaceInitialized = true;
  }
  loadWorkspaceData();
  fetchAndRenderTimesheet();
}

const TEAMS_OPEN_URL = "https://teams.live.com/v2/";
let teamsTokenPollTimer = null;

function openTeamsForTokenCapture() {
  if (typeof TEAMS_CAPTURE_LOGGING !== "undefined" && TEAMS_CAPTURE_LOGGING) {
    console.log("[Teams UI] opening", TEAMS_OPEN_URL);
  }
  chrome.tabs.create({ url: TEAMS_OPEN_URL }, (tab) => {
    if (!tab?.id) return;
    chrome.runtime.sendMessage({
      type: "SETUP_TEAMS_TOKEN_CAPTURE",
      tabId: tab.id,
    });
    startTeamsTokenStatusPoll();
  });
}

function startTeamsTokenStatusPoll() {
  if (teamsTokenPollTimer) clearInterval(teamsTokenPollTimer);
  let attempts = 0;

  teamsTokenPollTimer = setInterval(() => {
    attempts += 1;
    chrome.storage.local.get(
      ["teamsSkypeToken", "teamsTokenExpiry", "teamsTokenCapturedAt"],
      async (data) => {
        if (data.teamsSkypeToken) {
          updateTeamsTokenStatus(data.teamsSkypeToken, data.teamsTokenExpiry);
          if (!data.teamsTokenExpiry || data.teamsTokenExpiry > Date.now()) {
            clearInterval(teamsTokenPollTimer);
            teamsTokenPollTimer = null;
            const stored = await chrome.storage.local.get([
              "teamsFromId",
              "teamsConversationId",
            ]);
            if (data.teamsSkypeToken && !stored.teamsFromId) {
              const idResponse = await chrome.runtime.sendMessage({
                type: "FETCH_TEAMS_USER_ID",
              });
              if (idResponse?.success && idResponse.teamsFromId) {
                updateTeamsFromIdUI(idResponse.teamsFromId);
              }
            }
            await fetchTeamsGroups(stored.teamsConversationId);
          }
        }
        if (attempts >= 90) {
          clearInterval(teamsTokenPollTimer);
          teamsTokenPollTimer = null;
        }
      },
    );
  }, 2000);
}

function bindWorkspaceEvents() {
  document.getElementById("openTeamsBtn")?.addEventListener("click", () => {
    openTeamsForTokenCapture();
  });

  document.getElementById("openWorkspaceBtn")?.addEventListener("click", () => {
    openWorkspaceTasks();
  });

  document
    .getElementById("refreshTeamsTokenBtn")
    ?.addEventListener("click", () => {
      openTeamsForTokenCapture();
    });

  document
    .getElementById("workspaceSettingsForm")
    ?.addEventListener("submit", saveWorkspaceSettings);

  document.getElementById("sendSuggestedBtn")?.addEventListener("click", () => {
    const suggestion = document.getElementById(
      "smartSuggestionText",
    )?.textContent;
    if (suggestion && suggestion !== "--") {
      sendQuickEodMessage(suggestion);
    }
  });

  document.getElementById("sendCustomEodBtn")?.addEventListener("click", () => {
    const input = document.getElementById("customEodInput");
    const msg = input?.value.trim();
    if (msg) {
      sendQuickEodMessage(msg);
      input.value = "";
    }
  });

  document
    .getElementById("addPresetBtn")
    ?.addEventListener("click", addPresetMessage);
  document
    .getElementById("savePresetsBtn")
    ?.addEventListener("click", savePresetMessages);

  document
    .getElementById("eodEnabledToggle")
    ?.addEventListener("change", (e) => {
      chrome.storage.local.set({ eodEnabled: e.target.checked });
    });

  document.getElementById("quickEodList")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".quick-eod-btn");
    if (btn) {
      sendQuickEodMessage(btn.getAttribute("data-msg"));
    }
  });

  document
    .getElementById("fetchTeamsUserIdBtn")
    ?.addEventListener("click", fetchTeamsUserId);

  document
    .getElementById("refreshTimesheetBtn")
    ?.addEventListener("click", () => {
      fetchAndRenderTimesheet(true);
    });

  document
    .getElementById("timesheetOpenWorkspaceBtn")
    ?.addEventListener("click", openWorkspaceTasks);
  document
    .getElementById("timesheetOpenTasksBtn")
    ?.addEventListener("click", openWorkspaceTasks);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes.teamsSkypeToken ||
      changes.teamsTokenExpiry ||
      changes.teamsTokenCapturedAt
    ) {
      chrome.storage.local.get(
        ["teamsSkypeToken", "teamsTokenExpiry", "teamsFromId"],
        (data) => {
          updateTeamsTokenStatus(data.teamsSkypeToken, data.teamsTokenExpiry);
          if (data.teamsFromId) {
            updateTeamsFromIdUI(data.teamsFromId);
          }
        },
      );
    }
  });

  document.getElementById("workspaceTaskList")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".task-start-btn");
    if (btn) {
      startTaskTimer(btn.dataset.taskId);
    }
  });

  document
    .getElementById("workspaceAlertsToggle")
    ?.addEventListener("change", (e) => {
      chrome.storage.local.set({ workspaceAlertsEnabled: e.target.checked });
    });

  document
    .getElementById("workspaceAlertInterval")
    ?.addEventListener("change", (e) => {
      const minutes = parseInt(e.target.value, 10) || 15;
      chrome.storage.local.set({ workspaceAlertInterval: minutes }, () => {
        chrome.runtime.sendMessage({
          type: "UPDATE_WORKSPACE_ALARM_INTERVAL",
          minutes,
        });
      });
    });
}

function openWorkspaceTasks() {
  const url = "https://workspace.acquaintsoft.com/admin/staff/timesheets";
  wsUiLog.log("opening", url);

  chrome.tabs.create({ url }, (tab) => {
    if (!tab?.id) return;

    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        wsUiLog.log("tab loaded, retrying sync in 2s...");
        setTimeout(() => fetchAndRenderTimesheet(true), 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function loadWorkspaceData() {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SYNC_KEKA_PROFILE" }, () => resolve());
  });

  const data = await chrome.storage.local.get([
    "teamsConversationId",
    "teamsFromId",
    "teamsDisplayName",
    "kekaCompanyName",
    "teamsPrewrittenMessages",
    "teamsSkypeToken",
    "teamsTokenExpiry",
    "eodEnabled",
    "workspaceAlertsEnabled",
    "workspaceAlertInterval",
  ]);

  const displayNameInput = document.getElementById("teamsDisplayName");
  const companyNameEl = document.getElementById("kekaCompanyName");
  const fromIdInput = document.getElementById("teamsFromId");
  const eodToggle = document.getElementById("eodEnabledToggle");

  if (displayNameInput && data.teamsDisplayName) {
    displayNameInput.value = data.teamsDisplayName;
  }
  if (companyNameEl && data.kekaCompanyName) {
    companyNameEl.textContent = data.kekaCompanyName;
    companyNameEl.style.display = "block";
  } else if (companyNameEl) {
    companyNameEl.style.display = "none";
  }
  if (fromIdInput && data.teamsFromId) {
    fromIdInput.value = data.teamsFromId;
  }
  if (eodToggle) {
    eodToggle.checked = data.eodEnabled !== false;
  }

  const alertsToggle = document.getElementById("workspaceAlertsToggle");
  if (alertsToggle) {
    alertsToggle.checked = data.workspaceAlertsEnabled !== false;
  }

  const intervalSelect = document.getElementById("workspaceAlertInterval");
  if (intervalSelect) {
    intervalSelect.value = String(data.workspaceAlertInterval || 15);
  }

  updateTeamsTokenStatus(data.teamsSkypeToken, data.teamsTokenExpiry);

  if (!data.teamsSkypeToken) {
    hookOpenTeamsTabsForCapture();
  }

  if (
    !data.teamsFromId &&
    data.teamsSkypeToken &&
    data.teamsTokenExpiry > Date.now()
  ) {
    const idResponse = await chrome.runtime.sendMessage({
      type: "FETCH_TEAMS_USER_ID",
    });
    if (idResponse?.success && idResponse.teamsFromId) {
      data.teamsFromId = idResponse.teamsFromId;
    }
  }

  updateTeamsFromIdUI(data.teamsFromId);
  updateWorkspaceConfigStatus(data);
  await fetchTeamsGroups(data.teamsConversationId);
  renderPresetEditor(data.teamsPrewrittenMessages);
  renderQuickEodButtons(data.teamsPrewrittenMessages);
  await updateSmartSuggestion();
}

function hookOpenTeamsTabsForCapture() {
  const patterns = [
    "https://teams.live.com/*",
    "https://*.teams.live.com/*",
    "https://teams.microsoft.com/*",
    "https://*.teams.microsoft.com/*",
  ];
  chrome.tabs.query({ url: patterns }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.runtime.sendMessage({
          type: "SETUP_TEAMS_TOKEN_CAPTURE",
          tabId: tab.id,
        });
      }
    });
    if (tabs.length) startTeamsTokenStatusPoll();
  });
}

function updateTeamsTokenStatus(token, expiry) {
  const dot = document.getElementById("teamsTokenDot");
  const text = document.getElementById("teamsTokenText");
  const subtext = document.getElementById("teamsTokenExpiry");

  if (!dot || !text || !subtext) return;

  if (typeof TEAMS_CAPTURE_LOGGING !== "undefined" && TEAMS_CAPTURE_LOGGING) {
    const preview = token
      ? `${token.slice(0, 12)}… (${token.length} chars)`
      : "(none)";
    console.log("[Teams UI] status check:", {
      teamsSkypeToken: preview,
      teamsTokenExpiry: expiry ? new Date(expiry).toISOString() : null,
      valid: !!(token && (!expiry || expiry > Date.now())),
    });
  }

  if (!token) {
    dot.className = "status-dot red";
    text.textContent = t("ws_token_none");
    subtext.textContent = t("ws_token_none_hint");
    return;
  }

  const now = Date.now();
  if (expiry && now > expiry) {
    dot.className = "status-dot red";
    text.textContent = t("ws_token_expired");
    subtext.textContent = t("ws_token_expired_hint");
  } else {
    if (!expiry) {
      dot.className = "status-dot green";
      text.textContent = t("ws_token_valid");
      subtext.textContent = "";
      return;
    }

    const hoursLeft = Math.floor((expiry - now) / (1000 * 60 * 60));
    const minutesLeft = Math.floor(
      ((expiry - now) % (1000 * 60 * 60)) / (1000 * 60),
    );

    dot.className = hoursLeft < 1 ? "status-dot yellow" : "status-dot green";
    text.textContent = t("ws_token_valid");
    subtext.textContent =
      hoursLeft < 1
        ? t("ws_token_expires_soon").replace("{m}", minutesLeft)
        : t("ws_token_expires")
            .replace("{h}", hoursLeft)
            .replace("{m}", minutesLeft);
  }
}

function updateWorkspaceConfigStatus(data) {
  const badge = document.getElementById("workspaceConfigBadge");
  const text = document.getElementById("workspaceConfigText");
  if (!badge || !text) return;

  const isConfigured = !!(
    data.teamsConversationId &&
    data.teamsFromId &&
    data.teamsDisplayName
  );
  if (isConfigured) {
    badge.textContent = t("ws_configured");
    badge.className = "card-badge ok";
    text.textContent = t("ws_configured_hint");
  } else {
    badge.textContent = t("ws_not_configured");
    badge.className = "card-badge warn";
    text.textContent = t("ws_not_configured_hint");
  }
}

async function fetchTeamsGroups(savedConversationId) {
  const select = document.getElementById("teamsGroupSelect");
  if (!select) return;

  select.innerHTML = `<option value="">${t("ws_groups_loading")}</option>`;

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_TEAMS_GROUPS",
  });

  if (!response?.success) {
    select.innerHTML = `<option value="">${t("ws_groups_error")}</option>`;
    return;
  }

  select.innerHTML = "";
  if (!response.groups.length) {
    select.innerHTML = `<option value="">${t("ws_groups_empty")}</option>`;
    return;
  }

  let savedFound = false;
  response.groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    if (group.id === savedConversationId) {
      option.selected = true;
      savedFound = true;
    }
    select.appendChild(option);
  });

  if (!savedFound && response.groups.length > 0) {
    select.options[0].selected = true;
  }
}

function updateTeamsFromIdUI(teamsFromId) {
  const autoEl = document.getElementById("teamsFromIdAuto");
  const fetchRow = document.getElementById("teamsFromIdFetchRow");
  const manualGroup = document.getElementById("teamsFromIdGroup");

  if (teamsFromId) {
    if (autoEl) {
      autoEl.style.display = "block";
      autoEl.textContent = t("ws_sender_auto");
    }
    if (fetchRow) fetchRow.style.display = "none";
    if (manualGroup) manualGroup.style.display = "none";
    return;
  }

  if (autoEl) autoEl.style.display = "none";
  if (fetchRow) fetchRow.style.display = "flex";
  if (manualGroup) manualGroup.style.display = "none";
}

async function fetchTeamsUserId() {
  const fetchBtn = document.getElementById("fetchTeamsUserIdBtn");
  if (fetchBtn) {
    fetchBtn.disabled = true;
    fetchBtn.textContent = t("ws_fetching_user_id");
  }

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_TEAMS_USER_ID",
  });

  if (fetchBtn) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = t("ws_fetch_user_id");
  }

  if (response?.success && response.teamsFromId) {
    await chrome.storage.local.set({ teamsFromId: response.teamsFromId });
    showWorkspaceToast(t("ws_user_id_fetched"));
    loadWorkspaceData();
    return;
  }

  const manualGroup = document.getElementById("teamsFromIdGroup");
  const fetchRow = document.getElementById("teamsFromIdFetchRow");
  if (fetchRow) fetchRow.style.display = "none";
  if (manualGroup) manualGroup.style.display = "block";
  showWorkspaceToast(t("ws_user_id_fetch_failed"), "error");
}

async function saveWorkspaceSettings(e) {
  e.preventDefault();

  const displayName = document.getElementById("teamsDisplayName")?.value.trim();
  const conversationId = document.getElementById("teamsGroupSelect")?.value;
  const manualFromId = document.getElementById("teamsFromId")?.value.trim();
  const stored = await chrome.storage.local.get(["teamsFromId"]);
  const fromId = manualFromId || stored.teamsFromId;

  if (!displayName || !conversationId) {
    showWorkspaceToast(t("ws_save_error"), "error");
    return;
  }

  if (!fromId) {
    showWorkspaceToast(t("ws_user_id_required"), "error");
    return;
  }

  await chrome.storage.local.set({
    teamsConversationId: conversationId,
    teamsFromId: fromId,
    teamsDisplayName: displayName,
  });

  showWorkspaceToast(t("ws_save_success"));
  loadWorkspaceData();
}

function renderQuickEodButtons(messages) {
  const container = document.getElementById("quickEodList");
  if (!container) return;

  const list =
    Array.isArray(messages) && messages.length
      ? messages
      : DEFAULT_EOD_MESSAGES;
  container.innerHTML = list
    .map(
      (msg) =>
        `<button type="button" class="quick-eod-btn" data-msg="${escapeHtmlAttr(msg)}">${escapeHtml(msg)}</button>`,
    )
    .join("");
}

function renderPresetEditor(messages) {
  const container = document.getElementById("presetMessagesList");
  if (!container) return;

  const list =
    Array.isArray(messages) && messages.length
      ? [...messages]
      : [...DEFAULT_EOD_MESSAGES];
  container.innerHTML = list
    .map(
      (msg, i) => `
        <div class="preset-row">
            <input type="text" class="preset-input" data-index="${i}" value="${escapeHtmlAttr(msg)}">
            <button type="button" class="btn-icon-remove preset-remove" data-index="${i}" title="Remove">&times;</button>
        </div>
    `,
    )
    .join("");

  container.querySelectorAll(".preset-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".preset-row")?.remove();
    });
  });
}

function addPresetMessage() {
  const container = document.getElementById("presetMessagesList");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "preset-row";
  row.innerHTML = `
        <input type="text" class="preset-input" placeholder="${t("ws_preset_placeholder")}">
        <button type="button" class="btn-icon-remove preset-remove" title="Remove">&times;</button>
    `;
  row
    .querySelector(".preset-remove")
    .addEventListener("click", () => row.remove());
  container.appendChild(row);
}

async function savePresetMessages() {
  const inputs = document.querySelectorAll("#presetMessagesList .preset-input");
  const messages = Array.from(inputs)
    .map((input) => input.value.trim())
    .filter((msg) => msg.length > 0);

  if (messages.length === 0) {
    showWorkspaceToast(t("ws_presets_empty"), "error");
    return;
  }

  await chrome.storage.local.set({ teamsPrewrittenMessages: messages });
  renderQuickEodButtons(messages);
  showWorkspaceToast(t("ws_presets_saved"));
  await updateSmartSuggestion();
}

async function updateSmartSuggestion() {
  const suggestionEl = document.getElementById("smartSuggestionText");
  const contextEl = document.getElementById("smartSuggestionContext");
  if (!suggestionEl) return;

  const response = await chrome.runtime.sendMessage({
    type: "GET_SMART_EOD_SUGGESTION",
  });
  const suggestion = response?.suggestion || DEFAULT_EOD_MESSAGES[0];

  suggestionEl.textContent = suggestion;

  if (contextEl) {
    const { scrapedAttendance } = await chrome.storage.local.get([
      "scrapedAttendance",
    ]);
    const hasData = scrapedAttendance?.entries?.length > 0;
    contextEl.textContent = hasData
      ? t("ws_suggestion_from_keka")
      : t("ws_suggestion_no_keka");
  }

  document.querySelectorAll(".quick-eod-btn").forEach((btn) => {
    const msg = btn.getAttribute("data-msg");
    btn.classList.toggle("suggested", msg === suggestion);
  });
}

function sendQuickEodMessage(message) {
  const statusEl = document.getElementById("eodSendStatus");
  if (statusEl) {
    statusEl.textContent = t("ws_sending");
    statusEl.className = "workspace-status info";
  }

  chrome.runtime.sendMessage(
    { type: "SEND_TEAMS_MESSAGE", message },
    (response) => {
      if (!statusEl) return;

      if (response?.success) {
        statusEl.textContent = t("ws_sent_success");
        statusEl.className = "workspace-status success";
      } else {
        statusEl.textContent = response?.error || t("ws_sent_error");
        statusEl.className = "workspace-status error";
      }

      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "workspace-status";
      }, 4000);
    },
  );
}

function showWorkspaceToast(message, type = "success") {
  const toast = document.getElementById("workspaceToast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `workspace-toast visible ${type}`;
  setTimeout(() => {
    toast.className = "workspace-toast";
  }, 2500);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeHtmlAttr(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

async function fetchAndRenderTimesheet(showToast = false) {
  const connectPrompt = document.getElementById("timesheetConnectPrompt");
  const dataSection = document.getElementById("timesheetData");
  const refreshBtn = document.getElementById("refreshTimesheetBtn");
  const syncTimeEl = document.getElementById("timesheetSyncTime");

  wsUiLog.log("fetchAndRenderTimesheet start");

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = t("ws_timesheet_syncing");
  }

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_WORKSPACE_DATA",
  });

  wsUiLog.log("FETCH_WORKSPACE_DATA response:", response);

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = t("ws_timesheet_refresh");
  }

  if (!response?.success) {
    const cached = await chrome.storage.local.get([
      "workspaceTimesheet",
      "workspaceActiveTimer",
      "workspaceTasksList",
    ]);
    wsUiLog.log("fetch failed, cache:", cached);

    if (cached.workspaceTimesheet) {
      if (connectPrompt) connectPrompt.style.display = "none";
      if (dataSection) dataSection.style.display = "block";
      renderTimesheet(
        cached.workspaceTimesheet,
        cached.workspaceActiveTimer,
        cached.workspaceTasksList,
      );
      if (syncTimeEl) {
        syncTimeEl.textContent = `${response?.error || t("ws_timesheet_no_session")} (cached)`;
      }
      return;
    }

    if (connectPrompt) connectPrompt.style.display = "block";
    if (dataSection) dataSection.style.display = "none";
    if (syncTimeEl) {
      const debug = response?.debug?.cookieNames?.length
        ? ` [cookies: ${response.debug.cookieNames.join(", ")}]`
        : "";
      syncTimeEl.textContent =
        (response?.error || t("ws_timesheet_no_session")) + debug;
    }
    stopTimesheetElapsedTimer();
    return;
  }

  if (connectPrompt) connectPrompt.style.display = "none";
  if (dataSection) dataSection.style.display = "block";

  renderTimesheet(response.timesheet, response.activeTimer, response.tasksList);

  if (showToast) {
    showWorkspaceToast(t("sync_success"));
  }
}

async function startTaskTimer(taskId) {
  if (!taskId) return;

  const btn = document.querySelector(`.task-start-btn[data-task-id="${taskId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("ws_task_starting");
  }

  const response = await chrome.runtime.sendMessage({
    type: "START_WORKSPACE_TIMER",
    taskId,
  });

  if (btn) {
    btn.disabled = false;
    btn.textContent = t("ws_task_start");
  }

  if (response?.success) {
    showWorkspaceToast(t("ws_timer_started"));
    if (response.timesheet) {
      renderTimesheet(response.timesheet, response.activeTimer, response.tasksList);
    } else {
      await fetchAndRenderTimesheet(true);
    }
    return;
  }

  const errMsg =
    response?.error === "A timer is already running"
      ? t("ws_timer_already_running")
      : response?.error || t("ws_timer_start_failed");
  showWorkspaceToast(errMsg, "error");
}

function renderTaskList(tasksList) {
  const section = document.getElementById("workspaceTaskListSection");
  const container = document.getElementById("workspaceTaskList");
  if (!section || !container) return;

  const tasks = Array.isArray(tasksList) ? tasksList : [];

  if (!tasks.length) {
    section.style.display = "block";
    container.innerHTML = `<p class="card-text">${t("ws_tasks_empty")}</p>`;
    return;
  }

  section.style.display = "block";
  container.innerHTML = tasks
    .map((task) => {
      const project = task.projectName
        ? `<span class="task-project">${escapeHtml(task.projectName)}</span>`
        : "";
      return `
        <div class="workspace-task-row">
          <div class="workspace-task-info">
            <span class="workspace-task-name">${escapeHtml(task.taskName)}</span>
            ${project}
          </div>
          <button type="button" class="btn btn-secondary btn-sm task-start-btn"
            data-task-id="${escapeHtmlAttr(task.taskId)}"
            data-i18n="ws_task_start">${t("ws_task_start")}</button>
        </div>`;
    })
    .join("");
}

function renderTimesheet(timesheet, activeTimer, tasksList) {
  const totalEl = document.getElementById("timesheetTotalHours");
  const taskEl = document.getElementById("timesheetActiveTask");
  const lastEntryEl = document.getElementById("timesheetLastEntry");
  const elapsedEl = document.getElementById("timesheetElapsed");
  const badge = document.getElementById("timesheetTimerBadge");
  const syncTimeEl = document.getElementById("timesheetSyncTime");

  if (totalEl) {
    totalEl.textContent = timesheet?.totalHours || "00:00";
  }

  const isRunning = !!(activeTimer || timesheet?.runningEntry);
  const taskListSection = document.getElementById("workspaceTaskListSection");

  if (isRunning) {
    if (taskListSection) taskListSection.style.display = "none";
  } else {
    renderTaskList(tasksList);
  }

  if (badge) {
    badge.textContent = isRunning
      ? t("ws_timesheet_running")
      : t("ws_timesheet_stopped");
    badge.className = isRunning ? "card-badge ok" : "card-badge warn";
  }

  if (taskEl) {
    if (activeTimer) {
      const project = activeTimer.projectName
        ? ` (${activeTimer.projectName})`
        : "";
      taskEl.textContent = `${activeTimer.taskName}${project}`;
    } else {
      taskEl.textContent = "--";
    }
  }

  if (lastEntryEl) {
    const entries = timesheet?.entries || [];
    if (!entries.length) {
      lastEntryEl.textContent = t("ws_timesheet_none");
    } else {
      const latest = entries[0];
      const end = latest.end || t("ws_timesheet_running");
      lastEntryEl.textContent = `${latest.start} – ${end}`;
    }
  }

  if (syncTimeEl && timesheet?.syncedAt) {
    syncTimeEl.textContent = `${t("ws_timesheet_sync")}: ${new Date(timesheet.syncedAt).toLocaleTimeString()}`;
  }

  if (isRunning && timesheet?.runningEntry?.start) {
    startTimesheetElapsedTimer(timesheet.runningEntry.start, elapsedEl);
  } else {
    stopTimesheetElapsedTimer();
    if (elapsedEl) elapsedEl.textContent = "--";
  }
}

function parseTimesheetStartTime(startStr) {
  if (!startStr) return null;
  const today = new Date();
  const [time, meridiem] = startStr.split(" ");
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  let h = hours;
  if (meridiem?.toUpperCase() === "PM" && h < 12) h += 12;
  if (meridiem?.toUpperCase() === "AM" && h === 12) h = 0;
  return new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    h,
    minutes || 0,
    0,
  );
}

function formatElapsed(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

function startTimesheetElapsedTimer(startStr, elapsedEl) {
  stopTimesheetElapsedTimer();
  const startTime = parseTimesheetStartTime(startStr);
  if (!startTime || !elapsedEl) return;

  const update = () => {
    const elapsed = Date.now() - startTime.getTime();
    elapsedEl.textContent = elapsed > 0 ? formatElapsed(elapsed) : "--";
  };

  update();
  timesheetElapsedInterval = setInterval(update, 60000);
}

function stopTimesheetElapsedTimer() {
  if (timesheetElapsedInterval) {
    clearInterval(timesheetElapsedInterval);
    timesheetElapsedInterval = null;
  }
}
