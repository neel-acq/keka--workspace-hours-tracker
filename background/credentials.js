// Auto-open Keka / Teams / Workspace to capture missing tokens and sessions.

const credLog = typeof createLogger === 'function'
    ? createLogger('[Credentials]')
    : { log() {}, warn() {} };

const CREDENTIAL_COOLDOWN_MS = 10 * 60 * 1000;
const CREDENTIAL_WATCH_INTERVAL_MS = 3000;
const CREDENTIAL_WATCH_TIMEOUT_MS = 90000;
const TEAMS_TOKEN_MARGIN_MS = 15 * 60 * 1000;

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

async function openCredentialTabIfNeeded(service, { skipCooldown = false } = {}) {
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

    if (!skipCooldown && lastRun[service] && now - lastRun[service] < CREDENTIAL_COOLDOWN_MS) {
        credLog.log('skip', service, '(cooldown)');
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
            await chrome.tabs.update(tabId, { url: config.url, active: true });
        } else {
            const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
            if (normalWindows.length > 0) {
                const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
                const tab = await chrome.tabs.create({ url: config.url, active: true, windowId: targetWindow.id });
                tabId = tab.id;
                windowId = targetWindow.id;
                created = true;
            } else {
                const newWindow = await chrome.windows.create({ url: config.url, type: 'normal', focused: true });
                tabId = newWindow.tabs[0].id;
                windowId = newWindow.id;
                created = true;
            }
        }

        // Focus the window so the user sees the tab
        if (windowId) {
            chrome.windows.update(windowId, { focused: true }).catch(() => {});
        }

        if (service === 'teams' && tabId && typeof setupTeamsTabCapture === 'function') {
            setupTeamsTabCapture(tabId);
        }

        const stored = await chrome.storage.local.get({ credentialAutoTabs: {} });
        const autoTabs = stored.credentialAutoTabs || {};
        autoTabs[service] = { tabId, created, openedAt: now };
        lastRun[service] = now;

        await chrome.storage.local.set({
            credentialAutoTabs: autoTabs,
            credentialEnsureLastRun: lastRun
        });

        credLog.log('opened', service, created ? '(new tab)' : '(existing tab)', tabId);
        return true;
    } catch (err) {
        credLog.warn('open failed', service, err?.message || err);
        return false;
    } finally {
        setTimeout(() => credentialEnsureInFlight.delete(service), 30000);
    }
}

async function closeAutoTabForService(service) {
    const { credentialAutoTabs = {} } = await chrome.storage.local.get({ credentialAutoTabs: {} });
    const entry = credentialAutoTabs[service];
    if (!entry?.created || !entry.tabId) return false;

    chrome.tabs.remove(entry.tabId).catch(() => {});
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
                }
            }

            const remaining = [];
            for (const service of services) {
                if (!(await isServiceValid(service))) remaining.push(service);
            }

            if (!remaining.length) {
                credLog.log('watch complete, all captured');
                activeWatchers.delete(watchKey);
                return;
            }

            if (Date.now() - started > CREDENTIAL_WATCH_TIMEOUT_MS) {
                credLog.warn('watch timeout, still missing:', remaining.join(', '));
                activeWatchers.delete(watchKey);
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

async function ensureRequiredCredentials(source = 'unknown') {
    if (ensureRunPromise) {
        credLog.log('join in-flight ensure from', source);
        return ensureRunPromise;
    }

    // User-triggered sources skip the cooldown so websites always open
    const isUserAction = source === 'popup_open' || source === 'manual';

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
                skipCooldown: isUserAction || source === 'auto_next'
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
            let capturedSomething = false;
            for (const service of Object.keys(CREDENTIAL_SERVICES)) {
                if (await isServiceValid(service)) {
                    const closed = await closeAutoTabForService(service);
                    if (closed) capturedSomething = true;
                }
            }
            
            // If we just captured and closed a tab, check if there are more missing
            if (capturedSomething || relevant) {
                const status = await getCredentialStatus();
                if (!status.allValid) {
                    setTimeout(() => {
                        ensureRequiredCredentials('auto_next').catch(() => {});
                    }, 1500); // Small delay to let SSO cookies settle
                }
            }
        })();
    });

    credLog.log('module ready');
}

initCredentialsModule();
