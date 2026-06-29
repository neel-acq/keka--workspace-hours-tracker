// Workspace EOD / Teams integration module

const DEFAULT_EOD_MESSAGES = [
    'Good Morning.',
    'Going For Break.',
    'Back from Break.',
    'Leaving for the day',
    'Done for today, see you tomorrow!'
];

const EIGHT_HOURS_SECONDS = 8 * 60 * 60;

function initEodModule() {
    chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
            for (const header of details.requestHeaders) {
                if (header.name.toLowerCase() === 'authentication') {
                    const authValue = header.value;
                    if (authValue && authValue.startsWith('skypetoken=')) {
                        const token = authValue.substring(11);
                        saveTeamsToken(token);
                    }
                    break;
                }
            }
            return { requestHeaders: details.requestHeaders };
        },
        { urls: ['https://*.teams.live.com/*', 'https://teams.live.com/*'] },
        ['requestHeaders', 'extraHeaders']
    );

    chrome.webRequest.onCompleted.addListener(
        async (details) => {
            if (!details.url.includes('timer_tracking')) return;

            const { eodEnabled } = await chrome.storage.local.get({ eodEnabled: true });
            if (eodEnabled === false) return;

            if (details.tabId >= 0) {
                const suggestion = await computeSmartEodSuggestion();
                chrome.tabs.sendMessage(details.tabId, {
                    action: 'showEodModal',
                    suggestedMessage: suggestion
                }).catch(() => {});
            }
        },
        { urls: ['https://workspace.acquaintsoft.com/admin/tasks/timer_tracking*'] }
    );

    setupEodCorsBypass();
}

function saveTeamsToken(token) {
    const fromId = extractTeamsFromId(token);
    const storageUpdate = {
        teamsSkypeToken: token,
        teamsTokenExpiry: Date.now() + (7 * 60 * 60 * 1000)
    };

    try {
        const payloadStr = atob(token.split('.')[1]);
        const payload = JSON.parse(payloadStr);
        storageUpdate.teamsTokenExpiry = payload.exp * 1000;
    } catch (e) {
        // fallback expiry already set
    }

    if (fromId) {
        storageUpdate.teamsFromId = fromId;
    }

    chrome.storage.local.set(storageUpdate, () => {
        syncTeamsCredentialsToApi();
    });
}

function parseTeamsTokenPayload(token) {
    if (!token || !token.includes('.')) return null;
    try {
        const payloadStr = atob(token.split('.')[1]);
        return JSON.parse(payloadStr);
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

async function handleSendTeamsMessage(messageText) {
    if (API_ENABLED) {
        const apiResult = await apiSendTeamsMessage(messageText);
        if (apiResult.success) return { success: true };
        if (apiResult.error && !apiResult.error.includes('not configured')) {
            return { success: false, error: apiResult.error };
        }
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
        return { success: false, error: 'Missing Teams configuration. Please configure in the Workspace tab.' };
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

    const todayEntry = findTodayAttendanceEntry(scrapedAttendance.entries);
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

function findTodayAttendanceEntry(entries) {
    if (!entries || entries.length === 0) return null;

    const today = new Date();
    const todayDay = today.getDate();
    const todayMonth = today.toLocaleString('en-US', { month: 'short' });

    let found = entries.find(entry => {
        if (!entry.date) return false;
        const dateMatch = entry.date.match(/(\d+)\s+(\w+)/);
        if (!dateMatch) return false;
        return parseInt(dateMatch[1]) === todayDay &&
            dateMatch[2].toLowerCase() === todayMonth.toLowerCase();
    });

    return found || entries[0] || null;
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
