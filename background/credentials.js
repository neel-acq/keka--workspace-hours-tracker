// Auto-open Keka / Teams / Workspace to capture missing tokens and sessions.

const credLog = typeof createLogger === 'function'
    ? createLogger('[Credentials]')
    : { log() {}, warn() {} };

const CREDENTIAL_COOLDOWN_MS = 10 * 60 * 1000;
const CREDENTIAL_WATCH_INTERVAL_MS = 3000;
const CREDENTIAL_WATCH_TIMEOUT_MS = 180000; // 3 minutes — enough for first-time SSO login
const TEAMS_TOKEN_MARGIN_MS = 15 * 60 * 1000;
const SILENT_REFRESH_INTERVAL_MIN = 30; // check every 30 minutes

// Circuit breaker: exponential backoff cooldowns per failure count
const CREDENTIAL_BACKOFF_MS = [
    10 * 60 * 1000,   // 1st attempt: 10 min (default)
    30 * 60 * 1000,   // 2nd failure: 30 min
    60 * 60 * 1000    // 3rd+ failure: 60 min (max)
];
const CREDENTIAL_MAX_FAILURES = CREDENTIAL_BACKOFF_MS.length - 1;

// In-memory failure counters (persisted to storage for cross-restart survival)
const credentialFailures = {}; // { keka: { count: 0, lastAttempt: 0 } }

async function loadFailureCounts() {
    const { credentialFailureCounts = {} } = await chrome.storage.local.get('credentialFailureCounts');
    Object.assign(credentialFailures, credentialFailureCounts);
}

async function saveFailureCounts() {
    await chrome.storage.local.set({ credentialFailureCounts: { ...credentialFailures } });
}

function getBackoffCooldown(service) {
    const record = credentialFailures[service];
    if (!record || record.count <= 0) return CREDENTIAL_COOLDOWN_MS;
    const idx = Math.min(record.count, CREDENTIAL_MAX_FAILURES);
    return CREDENTIAL_BACKOFF_MS[idx];
}

async function recordFailure(service) {
    if (!credentialFailures[service]) {
        credentialFailures[service] = { count: 0, lastAttempt: 0 };
    }
    credentialFailures[service].count++;
    credentialFailures[service].lastAttempt = Date.now();
    credLog.warn('failure recorded for', service, '— count:', credentialFailures[service].count,
        '— next backoff:', getBackoffCooldown(service) / 60000, 'min');
    await saveFailureCounts();
}

async function resetFailure(service) {
    if (credentialFailures[service] && credentialFailures[service].count > 0) {
        credLog.log('failure count reset for', service);
        credentialFailures[service] = { count: 0, lastAttempt: 0 };
        await saveFailureCounts();
    }
}

const KEKA_CAPTURE_URL = 'https://acquaint.keka.com/#/me/attendance/logs';
const TEAMS_CAPTURE_URL = 'https://teams.microsoft.com/v2/';
const WORKSPACE_CAPTURE_URL = 'https://workspace.acquaintsoft.com/admin/staff/timesheets';

const CREDENTIAL_SERVICES = {
    keka: {
        patterns: ['https://*.keka.com/*'],
        url: KEKA_CAPTURE_URL
    },
    teams: {
        patterns: [
            'https://teams.live.com/*',
            'https://*.teams.live.com/*',
            'https://teams.microsoft.com/*',
            'https://*.teams.microsoft.com/*'
        ],
        url: TEAMS_CAPTURE_URL
    },
    workspace: {
        patterns: ['https://workspace.acquaintsoft.com/*'],
        url: WORKSPACE_CAPTURE_URL
    }
};

const credentialEnsureInFlight = new Set();
let ensureRunPromise = null;
const activeWatchers = new Set();
let autoNextTimer = null;

async function isKekaTokenValid() {
    const { kekaAuthToken } = await chrome.storage.local.get({ kekaAuthToken: '' });
    return !!(kekaAuthToken && String(kekaAuthToken).startsWith('eyJ'));
}

async function isTeamsTokenValid() {
    const { teamsSkypeToken, teamsTokenExpiry } = await chrome.storage.local.get({
        teamsSkypeToken: '',
        teamsTokenExpiry: 0
    });
    if (!teamsSkypeToken) return false;
    const minExpiry = Date.now() + TEAMS_TOKEN_MARGIN_MS;
    return teamsTokenExpiry > minExpiry;
}

async function isWorkspaceSessionValid() {
    if (typeof getWorkspaceAuth !== 'function') return false;
    const auth = await getWorkspaceAuth();
    return !!(auth?.success && auth.csrf);
}

async function isServiceValid(service) {
    if (service === 'keka') return isKekaTokenValid();
    if (service === 'teams') return isTeamsTokenValid();
    if (service === 'workspace') return isWorkspaceSessionValid();
    return false;
}

async function getCredentialStatus() {
    const [keka, teams, workspace] = await Promise.all([
        isKekaTokenValid(),
        isTeamsTokenValid(),
        isWorkspaceSessionValid()
    ]);

    return {
        keka: { valid: keka, label: 'Keka' },
        teams: { valid: teams, label: 'Teams' },
        workspace: { valid: workspace, label: 'Workspace' },
        allValid: keka && teams && workspace
    };
}

async function openCredentialTabIfNeeded(service, { skipCooldown = false, silent = false } = {}) {
    if (credentialEnsureInFlight.has(service)) {
        credLog.log('skip', service, '(in flight)');
        return false;
    }

    const config = CREDENTIAL_SERVICES[service];
    if (!config) return false;

    // Check if a browser window is open — tabs.create fails without one
    const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    if (!windows.length) {
        credLog.log('skip', service, '(no browser window)');
        return false;
    }

    const data = await chrome.storage.local.get({ credentialEnsureLastRun: {} });
    const lastRun = data.credentialEnsureLastRun || {};
    const now = Date.now();

    // Use dynamic backoff cooldown based on failure count
    const cooldownMs = getBackoffCooldown(service);
    if (!skipCooldown && lastRun[service] && now - lastRun[service] < cooldownMs) {
        credLog.log('skip', service, '(cooldown, backoff:', cooldownMs / 60000, 'min)');
        return false;
    }

    credentialEnsureInFlight.add(service);
    try {
        const existing = await chrome.tabs.query({ url: config.patterns });
        let tabId;
        let windowId;
        let created = false;

        if (existing.length) {
            tabId = existing[0].id;
            windowId = existing[0].windowId;
            // For silent refresh, don't activate; for interactive, bring to front
            await chrome.tabs.update(tabId, { url: config.url, active: !silent });
        } else {
            const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
            if (normalWindows.length > 0) {
                const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
                const tab = await chrome.tabs.create({
                    url: config.url,
                    active: !silent,
                    windowId: targetWindow.id
                });
                tabId = tab.id;
                windowId = targetWindow.id;
                created = true;
            } else {
                const newWindow = await chrome.windows.create({
                    url: config.url,
                    type: 'normal',
                    focused: !silent
                });
                tabId = newWindow.tabs[0].id;
                windowId = newWindow.id;
                created = true;
            }
        }

        // Only focus window for interactive (non-silent) credential capture
        if (windowId && !silent) {
            chrome.windows.update(windowId, { focused: true }).catch(() => {});
        }

        if (service === 'teams' && tabId && typeof setupTeamsTabCapture === 'function') {
            setupTeamsTabCapture(tabId);
        }

        const stored = await chrome.storage.local.get({ credentialAutoTabs: {} });
        const autoTabs = stored.credentialAutoTabs || {};
        autoTabs[service] = { tabId, created, openedAt: now, silent };
        lastRun[service] = now;

        await chrome.storage.local.set({
            credentialAutoTabs: autoTabs,
            credentialEnsureLastRun: lastRun
        });

        // Auto-close silent tabs after 60 seconds ONLY if capture succeeded.
        // If capture failed, leave the tab open so user can see the login page.
        if (silent && created) {
            setTimeout(async () => {
                try {
                    if (await isServiceValid(service)) {
                        chrome.tabs.remove(tabId).catch(() => {});
                        credLog.log('silent tab auto-closed for', service, '(capture succeeded)');
                    } else {
                        credLog.log('silent tab kept open for', service, '(capture failed — user needs to log in)');
                    }
                } catch (e) { /* tab may already be gone */ }
            }, 60000);
        }

        credLog.log('opened', service, created ? '(new tab)' : '(existing tab)', silent ? '(silent)' : '', tabId);
        return true;
    } catch (err) {
        credLog.warn('open failed', service, err?.message || err);
        return false;
    } finally {
        // 5 seconds is enough to prevent double-opens while still allowing quick retries
        setTimeout(() => credentialEnsureInFlight.delete(service), 5000);
    }
}

async function closeAutoTabForService(service) {
    const { credentialAutoTabs = {} } = await chrome.storage.local.get({ credentialAutoTabs: {} });
    const entry = credentialAutoTabs[service];
    if (!entry?.tabId) return false;

    // Close the tab if we created it (or if it was a silent refresh tab)
    if (entry.created || entry.silent) {
        chrome.tabs.remove(entry.tabId).catch(() => {});
    }

    delete credentialAutoTabs[service];
    await chrome.storage.local.set({ credentialAutoTabs });
    credLog.log('closed auto tab for', service);
    return true;
}

function scheduleCredentialCaptureWatch(services) {
    const watchKey = services.slice().sort().join(',');
    if (activeWatchers.has(watchKey)) return;
    activeWatchers.add(watchKey);

    const started = Date.now();

    const tick = async () => {
        try {
            for (const service of services) {
                if (await isServiceValid(service)) {
                    await closeAutoTabForService(service);
                    // Reset failure counter on successful capture
                    await resetFailure(service);
                }
            }

            const remaining = [];
            for (const service of services) {
                if (!(await isServiceValid(service))) remaining.push(service);
            }

            if (!remaining.length) {
                credLog.log('watch complete, all captured');
                activeWatchers.delete(watchKey);
                // Chain to next missing service after SUCCESSFUL capture
                triggerAutoNext();
                return;
            }

            if (Date.now() - started > CREDENTIAL_WATCH_TIMEOUT_MS) {
                credLog.warn('watch timeout, still missing:', remaining.join(', '));
                activeWatchers.delete(watchKey);
                // Record failure for each service that wasn't captured
                // Do NOT call triggerAutoNext() — this is the key anti-recursion fix.
                // The backoff cooldown will prevent immediate retries.
                for (const service of remaining) {
                    await recordFailure(service);
                }
                return;
            }

            setTimeout(tick, CREDENTIAL_WATCH_INTERVAL_MS);
        } catch (err) {
            credLog.warn('watch error', err?.message || err);
            activeWatchers.delete(watchKey);
        }
    };

    setTimeout(tick, CREDENTIAL_WATCH_INTERVAL_MS);
}

/**
 * Debounced trigger to open the next missing credential service.
 * Safe to call frequently — only fires once per 2-second window.
 * Uses 'auto_next' source which RESPECTS backoff cooldown (not skip it).
 */
function triggerAutoNext() {
    clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(async () => {
        const status = await getCredentialStatus();
        if (!status.allValid) {
            credLog.log('auto_next: still missing credentials, chaining...');
            // auto_next does NOT skip cooldown — backoff is respected
            ensureRequiredCredentials('auto_next').catch(() => {});
        }
    }, 2000);
}

async function ensureRequiredCredentials(source = 'unknown') {
    if (ensureRunPromise) {
        credLog.log('join in-flight ensure from', source);
        return ensureRunPromise;
    }

    // Only explicit user actions skip the cooldown — auto_next respects backoff
    const isUserAction = source === 'popup_open' || source === 'manual';
    const isSilent = source === 'silent_refresh';

    ensureRunPromise = (async () => {
        credLog.log('ensure start', source);
        const status = await getCredentialStatus();
        const missing = Object.keys(CREDENTIAL_SERVICES).filter((key) => !status[key].valid);

        if (!missing.length) {
            credLog.log('all credentials valid');
            return { success: true, refreshed: [], status };
        }

        credLog.log('missing:', missing.join(', '));
        const refreshed = [];

        // Only open ONE missing service at a time to prevent SSO conflicts
        for (const service of missing) {
            if (credentialEnsureInFlight.has(service)) {
                // If this service is already actively being opened, do not proceed to the next one
                break;
            }

            const opened = await openCredentialTabIfNeeded(service, {
                // Only user actions skip cooldown — auto_next, silent, startup all respect backoff
                skipCooldown: isUserAction,
                silent: isSilent
            });
            if (opened) {
                refreshed.push(service);
                break; // Stop after opening one tab
            }
        }

        if (refreshed.length) {
            scheduleCredentialCaptureWatch(refreshed);
        }

        return { success: true, refreshed, status: await getCredentialStatus() };
    })();

    try {
        return await ensureRunPromise;
    } finally {
        ensureRunPromise = null;
    }
}

function handleCredentialsMessage(message, sendResponse) {
    if (message.type === 'ENSURE_CREDENTIALS') {
        ensureRequiredCredentials(message.source || 'message').then(sendResponse);
        return true;
    }

    if (message.type === 'GET_CREDENTIAL_STATUS') {
        getCredentialStatus().then((status) => sendResponse({ success: true, status }));
        return true;
    }

    return false;
}

/**
 * Silent background refresh — opens tabs in background during work hours
 * to capture fresh tokens without user interaction (relies on SSO cookies).
 */
async function silentCredentialRefresh() {
    // Only during weekday work hours (9am–8pm IST)
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return;
    const hour = now.getHours();
    if (hour < 9 || hour > 20) return;

    const status = await getCredentialStatus();
    if (status.allValid) return;

    // Need at least one browser window open
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!windows.length) return;

    credLog.log('silent refresh: checking missing credentials');
    await ensureRequiredCredentials('silent_refresh');
}

function initCredentialsModule() {
    chrome.runtime.onStartup.addListener(() => {
        // Delay startup check to give browser time to fully open windows
        setTimeout(() => {
            ensureRequiredCredentials('extension_startup').catch(() => {});
        }, 3000);
    });

    chrome.runtime.onInstalled.addListener(() => {
        setTimeout(() => {
            ensureRequiredCredentials('extension_install').catch(() => {});
        }, 3000);
    });

    // Periodic silent refresh alarm
    chrome.alarms.create('credential_silent_refresh', {
        periodInMinutes: SILENT_REFRESH_INTERVAL_MIN
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'credential_silent_refresh') {
            silentCredentialRefresh().catch(() => {});
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.kekaAuthToken?.newValue && typeof resetKekaCaptureDedup === 'function') {
            resetKekaCaptureDedup(changes.kekaAuthToken.newValue);
        }

        const tokenKeys = ['kekaAuthToken', 'teamsSkypeToken', 'teamsTokenExpiry'];
        const sessionKeys = ['workspaceTimesheet'];
        const relevant = tokenKeys.some((k) => k in changes) || sessionKeys.some((k) => k in changes);
        if (!relevant) return;

        (async () => {
            let anyNewlyValid = false;

            // Close auto-tabs for services that are now valid
            for (const service of Object.keys(CREDENTIAL_SERVICES)) {
                if (await isServiceValid(service)) {
                    await closeAutoTabForService(service);
                    // Reset failure counter since capture succeeded
                    await resetFailure(service);
                    anyNewlyValid = true;
                }
            }

            // Only chain to next service if at least one service just became valid.
            // This prevents triggering auto_next when unrelated storage changes fire.
            if (anyNewlyValid) {
                triggerAutoNext();
            }
        })();
    });

    // Load persisted failure counts on module init
    loadFailureCounts().then(() => credLog.log('failure counts loaded'));

    credLog.log('module ready');
}

initCredentialsModule();
