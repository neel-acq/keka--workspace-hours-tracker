// Workspace EOD / Teams integration module

const DEFAULT_EOD_MESSAGES = [
    'Good Morning.',
    'Going For Break.',
    'Back from Break.',
    'Leaving for the day',
    'Done for today, see you tomorrow!'
];

const EIGHT_HOURS_SECONDS = 8 * 60 * 60;

/** chrome.storage.local keys used for Teams / EOD (8 total). */
const TEAMS_STORAGE_KEYS = [
    'teamsSkypeToken',      // 1 — JWT skypetoken (main auth token)
    'teamsTokenExpiry',     // 2 — expiry (ms epoch)
    'teamsTokenCapturedAt', // 3 — last capture time (ms epoch)
    'teamsFromId',          // 4 — sender id e.g. 8:live:.cid.xxx (from JWT)
    'teamsDisplayName',     // 5 — your name shown in Teams messages
    'teamsConversationId',  // 6 — selected group/chat id
    'teamsPrewrittenMessages', // 7 — quick EOD message presets
    'eodEnabled'            // 8 — EOD modal on/off
];

function teamsCaptureLog(...args) {
    if (typeof TEAMS_CAPTURE_LOGGING !== 'undefined' && TEAMS_CAPTURE_LOGGING) {
        console.log('[Teams Capture]', ...args);
    }
}

function maskToken(token) {
    if (!token || typeof token !== 'string') return '(empty)';
    if (token.length <= 24) return `${token.slice(0, 8)}…`;
    return `${token.slice(0, 12)}…${token.slice(-8)} (${token.length} chars)`;
}

function logTeamsStorageState(label = 'storage') {
    chrome.storage.local.get(TEAMS_STORAGE_KEYS, (data) => {
        const expiry = data.teamsTokenExpiry
            ? new Date(data.teamsTokenExpiry).toISOString()
            : null;
        const captured = data.teamsTokenCapturedAt
            ? new Date(data.teamsTokenCapturedAt).toISOString()
            : null;
        const valid = data.teamsSkypeToken && data.teamsTokenExpiry > Date.now();

        teamsCaptureLog(`${label}:`, {
            teamsSkypeToken: maskToken(data.teamsSkypeToken),
            teamsTokenExpiry: expiry,
            teamsTokenCapturedAt: captured,
            teamsFromId: data.teamsFromId || null,
            teamsDisplayName: data.teamsDisplayName || null,
            teamsConversationId: data.teamsConversationId
                ? `${String(data.teamsConversationId).slice(0, 24)}…`
                : null,
            teamsPrewrittenMessages: Array.isArray(data.teamsPrewrittenMessages)
                ? `${data.teamsPrewrittenMessages.length} preset(s)`
                : null,
            eodEnabled: data.eodEnabled !== false,
            tokenValid: !!valid
        });
    });
}

const TEAMS_WEB_REQUEST_URLS = [
    'https://*.teams.live.com/*',
    'https://teams.live.com/*',
    'https://*.teams.microsoft.com/*',
    'https://teams.microsoft.com/*',
    'https://*.skype.com/*',
    'https://*.asm.skype.com/*',
    'https://*.cloud.microsoft/*'
];

let lastSavedTeamsToken = null;
const EOD_PROMPT_DEBOUNCE_MS = 4000;
const lastEodPromptByTab = new Map();
const pendingTimerRequests = new Map();

function parseTimerTrackingIsStop(details) {
    const body = details.requestBody;
    if (!body) return false;

    if (body.formData?.timer_id?.[0]) {
        return String(body.formData.timer_id[0]).trim().length > 0;
    }

    if (body.raw?.length) {
        try {
            const chunks = body.raw.map((part) => {
                if (part.bytes) return new TextDecoder().decode(part.bytes);
                return '';
            });
            const params = new URLSearchParams(chunks.join(''));
            const timerId = params.get('timer_id');
            return !!(timerId && timerId.trim());
        } catch (e) {
            return false;
        }
    }

    return false;
}

async function promptEodModal(tabId, suggestedMessage, reason = 'timer_stop') {
    if (tabId < 0) return;

    const now = Date.now();
    const last = lastEodPromptByTab.get(tabId) || 0;
    if (now - last < EOD_PROMPT_DEBOUNCE_MS) return;
    lastEodPromptByTab.set(tabId, now);

    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    chrome.storage.local.set({ workspaceStopAlertSentDate: todayKey });

    const suggestion = suggestedMessage || await computeSmartEodSuggestion();
    chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_EOD_MODAL',
        reason,
        suggestedMessage: suggestion
    }).catch(() => {});
}

function initEodModule() {
    const eodLog = typeof createLogger === 'function' ? createLogger('[EOD]') : { log() {}, warn() {} };

    // MV3: observe only — no blocking return, no extraHeaders (both break registration).
    chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
            if (!details.requestHeaders) return;

            for (const header of details.requestHeaders) {
                if (header.name.toLowerCase() !== 'authentication') continue;
                const authValue = header.value;
                if (!authValue) continue;

                const match = authValue.match(/skypetoken=([^\s,;]+)/i);
                if (match?.[1]) {
                    teamsCaptureLog('webRequest saw skypetoken on', details.url);
                    captureTeamsToken(match[1], 'webRequest');
                    break;
                }
            }
        },
        { urls: TEAMS_WEB_REQUEST_URLS },
        ['requestHeaders']
    );

    eodLog.log('Teams token listener registered');
    teamsCaptureLog('Listener URLs:', TEAMS_WEB_REQUEST_URLS.join(', '));
    logTeamsStorageState('startup');

    chrome.storage.local.get({ teamsSkypeToken: '' }, (data) => {
        lastSavedTeamsToken = data.teamsSkypeToken || null;
    });

    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            if (!details.url.includes('timer_tracking') || details.method !== 'POST') return;
            pendingTimerRequests.set(details.requestId, {
                isStop: parseTimerTrackingIsStop(details),
                tabId: details.tabId,
                at: Date.now()
            });
        },
        { urls: ['https://workspace.acquaintsoft.com/admin/tasks/timer_tracking*'] },
        ['requestBody']
    );

    chrome.webRequest.onCompleted.addListener(
        async (details) => {
            if (!details.url.includes('timer_tracking')) return;

            const pending = pendingTimerRequests.get(details.requestId);
            pendingTimerRequests.delete(details.requestId);
            if (pending && Date.now() - pending.at > 60000) return;
            if (!pending?.isStop) return;

            const { eodEnabled } = await chrome.storage.local.get({ eodEnabled: true });
            if (eodEnabled === false) return;

            const tabId = details.tabId >= 0 ? details.tabId : pending.tabId;
            if (tabId >= 0) {
                await promptEodModal(tabId);
            }
        },
        { urls: ['https://workspace.acquaintsoft.com/admin/tasks/timer_tracking*'] }
    );

    setupEodCorsBypass();
    setupTeamsTokenRefreshAlarm();
    refreshTeamsTokenIfNeeded();
}

const TEAMS_OPEN_URL = 'https://teams.live.com/v2/';
const TEAMS_REFRESH_MARGIN_MS = 15 * 60 * 1000;

function setupTeamsTokenRefreshAlarm() {
    chrome.alarms.create('teams_token_refresh_check', { periodInMinutes: 45 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'teams_token_refresh_check') {
            refreshTeamsTokenIfNeeded();
        }
    });
}

async function refreshTeamsTokenIfNeeded() {
    const { teamsSkypeToken, teamsTokenExpiry } = await chrome.storage.local.get({
        teamsSkypeToken: '',
        teamsTokenExpiry: 0
    });

    if (!teamsSkypeToken) return;

    const now = Date.now();
    const needsRefresh = !teamsTokenExpiry || teamsTokenExpiry <= now + TEAMS_REFRESH_MARGIN_MS;
    if (!needsRefresh) return;

    teamsCaptureLog('token expired or expiring soon — opening Teams for capture');

    const patterns = [
        'https://teams.live.com/*',
        'https://*.teams.live.com/*'
    ];
    const existingTabs = await chrome.tabs.query({ url: patterns });
    let tabId;
    let createdTab = false;

    if (existingTabs.length) {
        tabId = existingTabs[0].id;
        await chrome.tabs.update(tabId, { url: TEAMS_OPEN_URL, active: false });
    } else {
        const tab = await chrome.tabs.create({ url: TEAMS_OPEN_URL, active: false });
        tabId = tab.id;
        createdTab = true;
    }

    if (tabId) {
        setupTeamsTabCapture(tabId);
    }

    if (createdTab && tabId) {
        setTimeout(async () => {
            const data = await chrome.storage.local.get({ teamsTokenExpiry: 0 });
            if (data.teamsTokenExpiry > Date.now()) {
                chrome.tabs.remove(tabId).catch(() => {});
            }
        }, 120000);
    }
}

function captureTeamsToken(token, source = 'unknown') {
    if (!token) return;
    const isNew = token !== lastSavedTeamsToken;
    teamsCaptureLog(`capture (${source}):`, isNew ? 'new token' : 'same token (refresh UI)', maskToken(token));
    lastSavedTeamsToken = token;
    if (isNew) {
        saveTeamsToken(token, source);
        return;
    }
    chrome.storage.local.set({ teamsTokenCapturedAt: Date.now() }, () => {
        logTeamsStorageState(`refresh (${source})`);
    });
}

function injectTeamsTokenHooks(tabId) {
    if (!tabId || tabId < 0) return Promise.resolve();
    teamsCaptureLog('injecting page hooks, tabId', tabId);
    return chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/teams/token-hook-main.js'],
        world: 'MAIN'
    }).then(() => {
        teamsCaptureLog('page hooks injected, tabId', tabId);
    }).catch((err) => {
        teamsCaptureLog('page hook inject failed, tabId', tabId, err?.message || err);
    });
}

function setupTeamsTabCapture(tabId) {
    teamsCaptureLog('setup capture for tabId', tabId);
    const runInject = () => injectTeamsTokenHooks(tabId);

    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        if (tab.status === 'complete') {
            setTimeout(runInject, 400);
        }
    });

    const listener = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        setTimeout(runInject, 400);
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 5 * 60 * 1000);
}

function saveTeamsToken(token, source = 'unknown') {
    const fromId = extractTeamsFromId(token);
    const storageUpdate = {
        teamsSkypeToken: token,
        teamsTokenExpiry: Date.now() + (7 * 60 * 60 * 1000)
    };

    try {
        const payload = parseTeamsTokenPayload(token);
        if (payload?.exp) {
            storageUpdate.teamsTokenExpiry = payload.exp * 1000;
        }
    } catch (e) {
        // fallback expiry already set
    }

    storageUpdate.teamsTokenCapturedAt = Date.now();

    if (fromId) {
        storageUpdate.teamsFromId = fromId;
    }

    chrome.storage.local.set(storageUpdate, () => {
        teamsCaptureLog('saved to chrome.storage.local:', {
            keysWritten: Object.keys(storageUpdate),
            teamsSkypeToken: maskToken(token),
            teamsTokenExpiry: new Date(storageUpdate.teamsTokenExpiry).toISOString(),
            teamsFromId: storageUpdate.teamsFromId || null,
            source
        });
        logTeamsStorageState(`saved (${source})`);
        if (typeof createLogger === 'function') {
            createLogger('[EOD]').log('Teams token saved via', source);
        }
        syncTeamsCredentialsToApi();
    });
}

function parseTeamsTokenPayload(token) {
    if (!token || !token.includes('.')) return null;
    try {
        const part = token.split('.')[1];
        const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        return JSON.parse(atob(padded));
    } catch (e) {
        return null;
    }
}

function extractTeamsFromId(token) {
    const payload = parseTeamsTokenPayload(token);
    if (!payload) return '';

    const cid = payload.cid || payload.CID || payload.skypeId || payload.skypeid;
    if (cid) {
        const normalized = String(cid).replace(/^8:live:\.cid\./i, '');
        return `8:live:.cid.${normalized}`;
    }

    if (payload.oid && String(payload.oid).includes('live:')) {
        return String(payload.oid);
    }

    if (payload.sub && String(payload.sub).startsWith('8:')) {
        return String(payload.sub);
    }

    if (payload.username && String(payload.username).startsWith('8:')) {
        return String(payload.username);
    }

    return '';
}

async function fetchTeamsUserIdFromStorage() {
    const { teamsSkypeToken } = await chrome.storage.local.get({ teamsSkypeToken: '' });
    if (!teamsSkypeToken) {
        return { success: false, error: 'No Teams token found' };
    }

    const teamsFromId = extractTeamsFromId(teamsSkypeToken);
    if (!teamsFromId) {
        return { success: false, error: 'Could not extract user ID from token' };
    }

    await chrome.storage.local.set({ teamsFromId });
    return { success: true, teamsFromId };
}

function setupEodCorsBypass() {
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [{
            id: 1,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [
                    { header: 'Origin', operation: 'set', value: 'https://teams.live.com' },
                    { header: 'Referer', operation: 'set', value: 'https://teams.live.com/' }
                ]
            },
            condition: {
                urlFilter: 'https://teams.live.com/api/chatsvc/*',
                resourceTypes: ['xmlhttprequest']
            }
        }]
    });
}

function handleEodMessage(message, sendResponse) {
    if (message.type === 'SYNC_TEAMS_CREDENTIALS') {
        syncTeamsCredentialsToApi().then(sendResponse);
        return true;
    }

    if (message.type === 'LOG_TEAMS_STORAGE') {
        logTeamsStorageState('manual');
        sendResponse({ success: true, keys: TEAMS_STORAGE_KEYS });
        return true;
    }

    if (message.type === 'TEAMS_TOKEN_CAPTURED' && message.token) {
        captureTeamsToken(message.token, 'content-script');
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'SETUP_TEAMS_TOKEN_CAPTURE' && message.tabId) {
        setupTeamsTabCapture(message.tabId);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'INJECT_TEAMS_TOKEN_HOOKS' && message.tabId) {
        injectTeamsTokenHooks(message.tabId).then(() => sendResponse({ success: true }));
        return true;
    }

    if (message.type === 'SEND_TEAMS_MESSAGE' || message.action === 'sendTeamsMessage') {
        handleSendTeamsMessage(message.message || message.text).then(sendResponse);
        return true;
    }

    if (message.type === 'GET_SMART_EOD_SUGGESTION') {
        computeSmartEodSuggestion().then(suggestion => sendResponse({ suggestion }));
        return true;
    }

    if (message.type === 'FETCH_TEAMS_GROUPS') {
        fetchTeamsGroups().then(sendResponse);
        return true;
    }

    if (message.type === 'FETCH_TEAMS_USER_ID') {
        fetchTeamsUserIdFromStorage().then(sendResponse);
        return true;
    }

    return false;
}

async function fetchTeamsGroups() {
    const config = await chrome.storage.local.get({
        teamsSkypeToken: '',
        teamsTokenExpiry: 0
    });

    if (!config.teamsSkypeToken || Date.now() > config.teamsTokenExpiry) {
        return { success: false, error: 'Teams token missing or expired' };
    }

    try {
        const response = await fetch(
            'https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations?view=msnp24Equivalent',
            { headers: { Authentication: `skypetoken=${config.teamsSkypeToken}` } }
        );

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const groups = (data.conversations || [])
            .filter(conv => conv.id && conv.threadProperties?.topic)
            .map(conv => ({ id: conv.id, name: conv.threadProperties.topic }));

        return { success: true, groups };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function isTeamsConfigApiError(error) {
    if (!error) return false;
    return /configuration|credentials not configured|not configured/i.test(error);
}

async function handleSendTeamsMessage(messageText) {
    if (API_ENABLED) {
        await syncTeamsCredentialsToApi();
        const apiResult = await apiSendTeamsMessage(messageText);
        if (apiResult.success) return { success: true };
        if (apiResult.error && !isTeamsConfigApiError(apiResult.error)) {
            return { success: false, error: apiResult.error };
        }
        teamsCaptureLog('API send skipped, trying local Teams send:', apiResult.error);
    }

    const config = await chrome.storage.local.get({
        teamsConversationId: '',
        teamsFromId: '',
        teamsDisplayName: '',
        teamsSkypeToken: '',
        teamsTokenExpiry: 0
    });

    let teamsFromId = config.teamsFromId;
    if (!teamsFromId && config.teamsSkypeToken) {
        teamsFromId = extractTeamsFromId(config.teamsSkypeToken);
        if (teamsFromId) {
            await chrome.storage.local.set({ teamsFromId });
        }
    }

    if (!config.teamsConversationId || !config.teamsDisplayName) {
        const missing = [];
        if (!config.teamsDisplayName) missing.push('display name');
        if (!config.teamsConversationId) missing.push('Teams group');
        return {
            success: false,
            error: `Missing Teams configuration (${missing.join(', ')}). Open Workspace tab, pick a group, enter your name, and click Save.`
        };
    }

    if (!teamsFromId) {
        return { success: false, error: 'Teams user ID not found. Open Teams or use Fetch User ID in Workspace tab.' };
    }

    if (!config.teamsSkypeToken || Date.now() > config.teamsTokenExpiry) {
        return { success: false, error: 'Teams token is missing or expired. Open Teams to refresh it.' };
    }

    const apiUrl = `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(config.teamsConversationId)}/messages`;
    const timestamp = new Date().toISOString();
    const clientMessageId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));

    const payload = {
        type: 'Message',
        conversationid: config.teamsConversationId,
        conversationLink: apiUrl,
        from: teamsFromId,
        fromUserId: teamsFromId,
        composetime: timestamp,
        originalarrivaltime: timestamp,
        content: `<p>${escapeHtml(messageText)}</p>`,
        messagetype: 'RichText/Html',
        contenttype: 'Text',
        imdisplayname: config.teamsDisplayName,
        clientmessageid: clientMessageId,
        callId: '',
        state: 0,
        version: '0',
        amsreferences: [],
        properties: {
            importance: '',
            subject: '',
            title: '',
            cards: '[]',
            links: '[]',
            mentions: '[]',
            onbehalfof: null,
            files: '[]',
            policyViolation: null,
            formatVariant: 'TEAMS'
        },
        crossPostChannels: []
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                authentication: `skypetoken=${config.teamsSkypeToken}`,
                behavioroverride: 'redirectAs404'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 100)}` };
        }

        return { success: true };
    } catch (error) {
        return { success: false, error: `Network error: ${error.message}` };
    }
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function computeSmartEodSuggestion() {
    if (API_ENABLED) {
        const apiResult = await apiGetEodSuggestion();
        if (apiResult.success && apiResult.suggestion) {
            return apiResult.suggestion;
        }
    }

    const { teamsPrewrittenMessages, scrapedAttendance } = await chrome.storage.local.get({
        teamsPrewrittenMessages: DEFAULT_EOD_MESSAGES,
        scrapedAttendance: null
    });

    const presets = Array.isArray(teamsPrewrittenMessages) && teamsPrewrittenMessages.length
        ? teamsPrewrittenMessages
        : DEFAULT_EOD_MESSAGES;

    const msg = (index, fallback) => presets[index] || fallback || presets[0];

    if (!scrapedAttendance || !scrapedAttendance.entries) {
        return msg(0, 'Good Morning.');
    }

    const todayEntry = findTodayAttendanceEntry(scrapedAttendance);
    if (!todayEntry) {
        return msg(0, 'Good Morning.');
    }

    const inOutArray = todayEntry.inOutArray;
    if (!inOutArray || inOutArray.length === 0) {
        const now = new Date();
        if (now.getHours() < 10) {
            return msg(0, 'Good Morning.');
        }
        return msg(3, 'Leaving for the day');
    }

    const stats = calculateAttendanceStats(inOutArray);
    if (!stats) {
        return presets[0];
    }

    const now = new Date();

    if (stats.lastSwipeType === 'OUT' && stats.minutesSinceLastSwipe < 30) {
        return msg(2, 'Back from Break.');
    }

    if (stats.lastSwipeType === 'IN' && stats.effectiveSeconds < EIGHT_HOURS_SECONDS) {
        return msg(1, 'Going For Break.');
    }

    if (stats.effectiveSeconds >= EIGHT_HOURS_SECONDS || now >= stats.targetExitTime) {
        return stats.effectiveSeconds >= EIGHT_HOURS_SECONDS
            ? msg(4, 'Done for today, see you tomorrow!')
            : msg(3, 'Leaving for the day');
    }

    return presets[0];
}

function findTodayAttendanceEntry(scrapedAttendance) {
    return resolveTodayEntry(scrapedAttendance);
}

function parseKekaTimeStr(timeStr) {
    if (!timeStr || timeStr === 'MISSING') return null;

    const today = new Date();
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
    if (!timeMatch) return null;

    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const seconds = parseInt(timeMatch[3]);
    const period = timeMatch[4].toUpperCase();

    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    today.setHours(hours, minutes, seconds, 0);
    return today;
}

function calculateAttendanceStats(inOutArray) {
    const validSwipes = inOutArray.filter(s => s.time && s.time !== 'MISSING');
    if (validSwipes.length === 0) return null;

    let firstIn = null;
    let totalEffectiveSeconds = 0;

    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseKekaTimeStr(swipe.time);
        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (!firstIn) firstIn = swipeTime;

            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseKekaTimeStr(validSwipes[i + 1].time);
                if (outTime) {
                    totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                }
            }
        }
    }

    const lastSwipe = validSwipes[validSwipes.length - 1];
    const lastSwipeTime = parseKekaTimeStr(lastSwipe.time);
    if (!lastSwipeTime) return null;

    if (lastSwipe.type === 'IN') {
        totalEffectiveSeconds += (Date.now() - lastSwipeTime.getTime()) / 1000;
    }

    let targetExitTime;
    if (firstIn) {
        const tenAM = new Date(firstIn);
        tenAM.setHours(10, 0, 0, 0);
        if (firstIn < tenAM) {
            targetExitTime = new Date(firstIn);
            targetExitTime.setHours(19, 0, 0, 0);
        } else {
            targetExitTime = new Date(firstIn.getTime() + 9 * 60 * 60 * 1000);
        }
    } else {
        targetExitTime = new Date();
    }

    return {
        effectiveSeconds: totalEffectiveSeconds,
        lastSwipeType: lastSwipe.type,
        minutesSinceLastSwipe: (Date.now() - lastSwipeTime.getTime()) / (1000 * 60),
        targetExitTime
    };
}

initEodModule();
