// Workspace timesheet + timer integration

const WORKSPACE_ORIGIN = 'https://workspace.acquaintsoft.com';
const WORKSPACE_BASE = WORKSPACE_ORIGIN;
const WORKSPACE_TASKS_URL = `${WORKSPACE_BASE}/admin/tasks`;
const WORKSPACE_TIMESHEETS_URL = `${WORKSPACE_BASE}/admin/staff/timesheets`;
const TIMER_TRACKING_URL = `${WORKSPACE_BASE}/admin/tasks/timer_tracking?single_task=true`;
const STOP_TIMER_THRESHOLD_HOURS = 8 + (5 / 60); // 8h 5m
const WS_LOG = '[Workspace]';

function wsLog(...args) {
    console.log(WS_LOG, ...args);
}

function wsWarn(...args) {
    console.warn(WS_LOG, ...args);
}

function getCookie(url, name) {
    return new Promise((resolve) => {
        chrome.cookies.get({ url, name }, (cookie) => {
            if (chrome.runtime.lastError) {
                wsWarn('cookies.get error', name, chrome.runtime.lastError.message);
                resolve(null);
                return;
            }
            resolve(cookie || null);
        });
    });
}

function getAllCookies(url) {
    return new Promise((resolve) => {
        chrome.cookies.getAll({ url }, (cookies) => {
            if (chrome.runtime.lastError) {
                wsWarn('cookies.getAll error', url, chrome.runtime.lastError.message);
                resolve([]);
                return;
            }
            resolve(cookies || []);
        });
    });
}

async function getWorkspaceTab() {
    const tabs = await chrome.tabs.query({ url: 'https://workspace.acquaintsoft.com/*' });
    return tabs.length ? tabs[0] : null;
}

async function getCsrfFromWorkspaceTab() {
    const tab = await getWorkspaceTab();
    if (!tab?.id) {
        wsWarn('no workspace tab for CSRF lookup');
        return null;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
                const match = document.cookie.match(/(?:^|;\s*)csrf_cookie_name=([^;]+)/);
                if (match) return decodeURIComponent(match[1].trim());

                const selectors = [
                    'input[name="csrf_token_name"]',
                    'input[name*="csrf"]',
                    '#csrf_token',
                    'meta[name="csrf-token"]',
                    'meta[name="csrf_token_name"]'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el?.value) return el.value;
                    if (el?.content) return el.content;
                }

                if (typeof window.csrfData !== 'undefined' && window.csrfData) {
                    return String(window.csrfData);
                }

                return null;
            }
        });
        const csrf = results?.[0]?.result || null;
        wsLog('csrf from tab DOM:', csrf ? csrf.slice(0, 8) + '...' : 'not found');
        return csrf;
    } catch (err) {
        wsWarn('getCsrfFromWorkspaceTab failed:', err.message);
        return null;
    }
}

async function resolveCsrfToken() {
    const cookie = await getCookie(WORKSPACE_ORIGIN + '/', 'csrf_cookie_name');
    if (cookie?.value) {
        wsLog('csrf from chrome.cookies');
        return cookie.value;
    }

    const auth = await getWorkspaceAuth();
    if (auth.success && auth.csrf) {
        return auth.csrf;
    }

    return getCsrfFromWorkspaceTab();
}

async function getWorkspaceAuth() {
    const urls = [
        WORKSPACE_ORIGIN + '/',
        WORKSPACE_ORIGIN + '/admin/',
        WORKSPACE_TIMESHEETS_URL
    ];

    const [directCsrf, directSession, ...urlCookieSets] = await Promise.all([
        getCookie(WORKSPACE_ORIGIN + '/', 'csrf_cookie_name'),
        getCookie(WORKSPACE_ORIGIN + '/', 'sp_session'),
        ...urls.map((url) => getAllCookies(url))
    ]);

    const seen = new Set();
    const cookies = [];

    [directCsrf, directSession].filter(Boolean).forEach((cookie) => {
        const key = `${cookie.name}|${cookie.domain}`;
        if (!seen.has(key)) {
            seen.add(key);
            cookies.push(cookie);
        }
    });

    urlCookieSets.flat().forEach((cookie) => {
        const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
        if (!seen.has(key)) {
            seen.add(key);
            cookies.push(cookie);
        }
    });

    wsLog('cookies found:', cookies.map(c => `${c.name}@${c.domain}`));

    const cookieMap = {};
    cookies.forEach(c => { cookieMap[c.name] = c.value; });

    let csrf = cookieMap.csrf_cookie_name || cookieMap.csrf_token_name;
    const session = cookieMap.sp_session || cookieMap.ci_session;

    if (!csrf) {
        wsWarn('csrf not in chrome.cookies — trying open workspace tab');
        csrf = await getCsrfFromWorkspaceTab();
    }

    if (!csrf) {
        wsWarn('missing CSRF. cookie names:', Object.keys(cookieMap));
        return {
            success: false,
            error: 'Workspace session not found. Open Workspace and log in.',
            debug: { cookieNames: Object.keys(cookieMap) }
        };
    }

    const workspaceCookies = cookies.filter(c => c.domain?.includes('acquaintsoft.com'));
    const cookieHeader = workspaceCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const tabOnly = !session || !cookieHeader;

    wsLog('auth ok — csrf:', csrf.slice(0, 8) + '...', 'session:', !!session, 'tabOnly:', tabOnly);

    if (API_ENABLED && session && Object.keys(cookieMap).length) {
        await syncWorkspaceCredentialsToApi({ csrfToken: csrf, cookies: cookieMap });
    }

    return { success: true, csrf, cookieHeader, hasSession: !!session, tabOnly, cookies: cookieMap };
}

function parseHtmlText(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseProjectName(html) {
    if (!html) return '';
    const match = html.match(/>([^<]+)<\/a>\s*$/);
    return match ? match[1].trim() : parseHtmlText(html);
}

function buildTimesheetsBody(csrf) {
    const params = new URLSearchParams();
    params.set('csrf_token_name', csrf);
    params.set('draw', '1');
    for (let i = 0; i < 7; i++) {
        params.set(`columns[${i}][data]`, String(i));
        params.set(`columns[${i}][name]`, '');
        params.set(`columns[${i}][searchable]`, 'true');
        params.set(`columns[${i}][orderable]`, 'true');
        params.set(`columns[${i}][search][value]`, '');
        params.set(`columns[${i}][search][regex]`, 'false');
    }
    params.set('order[0][column]', '2');
    params.set('order[0][dir]', 'desc');
    params.set('start', '0');
    params.set('length', '25');
    params.set('search[value]', '');
    params.set('search[regex]', 'false');
    params.set('range', 'today');
    params.set('period-from', '');
    params.set('period-to', '');
    return params.toString();
}

function buildTasksBody(csrf) {
    const params = new URLSearchParams();
    params.set('csrf_token_name', csrf);
    params.set('draw', '1');
    for (let i = 0; i < 9; i++) {
        params.set(`columns[${i}][data]`, String(i));
        params.set(`columns[${i}][name]`, '');
        params.set(`columns[${i}][searchable]`, 'true');
        params.set(`columns[${i}][orderable]`, 'true');
        params.set(`columns[${i}][search][value]`, '');
        params.set(`columns[${i}][search][regex]`, 'false');
    }
    params.set('order[0][column]', '4');
    params.set('order[0][dir]', 'desc');
    params.set('start', '0');
    params.set('length', '50');
    params.set('search[value]', '');
    params.set('search[regex]', 'false');
    return params.toString();
}

function parseTimesheetSummary(response) {
    const entries = (response.aaData || []).map(row => ({
        task: parseHtmlText(row[0]),
        start: row[1] || '',
        end: row[2] || null,
        note: row[3] || '',
        project: parseProjectName(row[4]),
        duration: row[5] || '',
        decimal: parseFloat(row[6]) || 0
    }));

    const runningEntry = entries.find(e => e.start && !e.end);

    return {
        totalHours: response.logged_time?.total_logged_time_h || '00:00',
        totalDecimal: parseFloat(response.logged_time?.total_logged_time_d) || 0,
        entries,
        runningEntry: runningEntry || null,
        syncedAt: new Date().toISOString()
    };
}

function parseTaskFromCell(cell) {
    if (!cell) return null;

    const idMatch = cell.match(/tasks\/view\/(\d+)/);
    if (!idMatch) return null;

    const nameMatch = cell.match(/main-tasks-table-href-name[^>]*>([^<]+)</);
    const projectMatch = cell.match(/task-table-related[^>]*>([^<]+)</);

    return {
        taskId: idMatch[1],
        taskName: nameMatch?.[1]?.trim() || 'Unknown task',
        projectName: projectMatch?.[1]?.trim() || '',
        isRunning: cell.includes('fa-clock') && cell.includes('text-danger')
    };
}

function parseTasksList(tasksResponse) {
    const seen = new Set();
    const tasks = [];

    for (const row of tasksResponse.aaData || []) {
        const cell = row['2'] || row[2] || '';
        const task = parseTaskFromCell(cell);
        if (!task || seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        tasks.push(task);
    }

    return tasks;
}

function parseActiveTimer(tasksResponse) {
    for (const row of tasksResponse.aaData || []) {
        const cell = row['2'] || row[2] || '';
        if (cell.includes('fa-clock') && cell.includes('text-danger')) {
            return parseTaskFromCell(cell);
        }
    }
    return null;
}

async function postWorkspaceApi(url, body, referer, auth) {
    wsLog('POST', url);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': auth.cookieHeader,
            'Referer': referer
        },
        body
    });

    const text = await response.text();
    wsLog('response', url, response.status, text.slice(0, 120));

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 100)}`);
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON (${text.slice(0, 80)})`);
    }
}

async function postViaWorkspaceTab(endpoint) {
    const tab = await getWorkspaceTab();
    if (!tab?.id) {
        wsWarn('tab fetch: no workspace tab open');
        return null;
    }

    wsLog('tab fetch via tab', tab.id, endpoint);

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (endpointType) => {
            function getCsrf() {
                const match = document.cookie.match(/(?:^|;\s*)csrf_cookie_name=([^;]+)/);
                if (match) return decodeURIComponent(match[1].trim());
                const input = document.querySelector(
                    'input[name="csrf_token_name"], input[name*="csrf"]'
                );
                return input?.value || '';
            }

            function buildBody(csrf, type) {
                const params = new URLSearchParams();
                params.set('csrf_token_name', csrf);
                params.set('draw', '1');

                const colCount = type === 'timesheet' ? 7 : 9;
                for (let i = 0; i < colCount; i++) {
                    params.set(`columns[${i}][data]`, String(i));
                    params.set(`columns[${i}][name]`, '');
                    params.set(`columns[${i}][searchable]`, 'true');
                    params.set(`columns[${i}][orderable]`, 'true');
                    params.set(`columns[${i}][search][value]`, '');
                    params.set(`columns[${i}][search][regex]`, 'false');
                }

                if (type === 'timesheet') {
                    params.set('order[0][column]', '2');
                    params.set('order[0][dir]', 'desc');
                    params.set('start', '0');
                    params.set('length', '25');
                    params.set('search[value]', '');
                    params.set('search[regex]', 'false');
                    params.set('range', 'today');
                    params.set('period-from', '');
                    params.set('period-to', '');
                    return { url: '/admin/staff/timesheets', body: params.toString() };
                }

                params.set('order[0][column]', '4');
                params.set('order[0][dir]', 'desc');
                params.set('start', '0');
                params.set('length', '50');
                params.set('search[value]', '');
                params.set('search[regex]', 'false');
                return { url: '/admin/tasks/table', body: params.toString() };
            }

            const csrf = getCsrf();
            if (!csrf) {
                return { ok: false, error: 'no csrf in tab', cookies: document.cookie };
            }

            const { url, body } = buildBody(csrf, endpointType);

            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body,
                    credentials: 'include'
                });
                const text = await res.text();
                return {
                    ok: res.ok,
                    status: res.status,
                    preview: text.slice(0, 200),
                    data: res.ok ? JSON.parse(text) : null,
                    error: res.ok ? null : text.slice(0, 100)
                };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        },
        args: [endpoint]
    });

    const result = results?.[0]?.result;
    wsLog('tab fetch result:', endpoint, result?.status, result?.preview || result?.error);

    if (!result?.ok || !result.data) {
        return null;
    }

    return result.data;
}

function buildTimerTrackingBody(csrf, taskId, timerId = '', note = '') {
    const params = new URLSearchParams();
    params.set('csrf_token_name', csrf);
    params.set('task_id', String(taskId));
    params.set('timer_id', timerId || '');
    params.set('note', note || '');
    return params.toString();
}

async function postTimerTrackingViaTab(taskId, timerId = '', note = '', csrfToken = null) {
    const csrf = csrfToken || await resolveCsrfToken();
    if (!csrf) {
        return {
            success: false,
            error: 'Workspace session not found. Open Workspace and log in.'
        };
    }

    const tab = await getWorkspaceTab();
    if (!tab?.id) {
        wsWarn('timer tracking: no workspace tab open');
        return { success: false, error: 'Open Workspace tab to start timer' };
    }

    wsLog('timer tracking via tab', tab.id, 'taskId:', taskId, 'csrf:', csrf.slice(0, 8) + '...');

    const body = buildTimerTrackingBody(csrf, taskId, timerId, note);

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (postBody) => {
            try {
                const res = await fetch('/admin/tasks/timer_tracking?single_task=true', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: postBody,
                    credentials: 'include'
                });
                const text = await res.text();
                let data = null;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    data = { raw: text };
                }
                return {
                    ok: res.ok,
                    status: res.status,
                    preview: text.slice(0, 200),
                    data
                };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        },
        args: [body]
    });

    const result = results?.[0]?.result;
    wsLog('timer tracking result:', result?.status, result?.preview || result?.error);

    if (!result?.ok) {
        return {
            success: false,
            error: result?.error || result?.preview || 'Timer request failed'
        };
    }

    return { success: true, data: result.data };
}

async function postTimerTracking(auth, taskId, timerId = '', note = '') {
    const csrf = auth?.csrf || await resolveCsrfToken();
    if (!csrf) {
        return { success: false, error: 'Workspace session not found. Open Workspace and log in.' };
    }

    const body = buildTimerTrackingBody(csrf, taskId, timerId, note);

    if (!auth?.tabOnly && auth?.cookieHeader) {
        try {
            const data = await postWorkspaceApi(
                TIMER_TRACKING_URL,
                body,
                `${WORKSPACE_BASE}/admin/tasks`,
                auth
            );
            return { success: true, data };
        } catch (bgError) {
            wsWarn('background timer tracking failed:', bgError.message);
        }
    }

    return postTimerTrackingViaTab(taskId, timerId, note, csrf);
}

async function startWorkspaceTimer(taskId, note = '') {
    wsLog('startWorkspaceTimer', taskId);

    const auth = await getWorkspaceAuth();

    if (API_ENABLED && auth.success && auth.hasSession && !auth.tabOnly) {
        const apiResult = await apiStartWorkspaceTimer(taskId, note || '');
        if (apiResult.success) {
            const { timesheet, activeTimer, tasksList } = apiResult;
            await chrome.storage.local.set({
                workspaceTimesheet: timesheet,
                workspaceActiveTimer: activeTimer,
                workspaceTasksList: tasksList,
                lastWorkspaceSync: timesheet?.syncedAt || new Date().toISOString()
            });
            await chrome.storage.local.set({ lastWorkspaceStartAlertAt: 0 });
            return { success: true, timesheet, activeTimer, tasksList };
        }
        wsWarn('API start timer failed, falling back local:', apiResult.error);
    }

    let localAuth = auth;
    if (!localAuth.success) {
        const tab = await getWorkspaceTab();
        const csrf = await getCsrfFromWorkspaceTab();
        if (tab && csrf) {
            localAuth = { success: true, csrf, cookieHeader: '', tabOnly: true };
        } else {
            return { success: false, error: localAuth.error || 'Workspace session not found' };
        }
    }

    const { activeTimer } = await fetchTasksData(localAuth);
    if (activeTimer) {
        return {
            success: false,
            error: 'A timer is already running',
            activeTimer
        };
    }

    const result = await postTimerTracking(localAuth, taskId, '', note || '');
    if (!result.success) {
        return result;
    }

    await chrome.storage.local.set({ lastWorkspaceStartAlertAt: 0 });

    const refreshed = await fetchWorkspaceData();
    if (refreshed.success) {
        return {
            success: true,
            timesheet: refreshed.timesheet,
            activeTimer: refreshed.activeTimer,
            tasksList: refreshed.tasksList
        };
    }

    return { success: true, message: 'Timer started' };
}

// async function stopWorkspaceTimer(taskId, timerId, note) {
//     wsLog('stopWorkspaceTimer', taskId, timerId);
//     const result = await postTimerTrackingViaTab(taskId, timerId, note || '');
//     if (!result.success) return result;
//     return fetchWorkspaceData();
// }

async function fetchTimesheetsToday(auth) {
    if (auth.tabOnly) {
        const data = await postViaWorkspaceTab('timesheet');
        if (!data) throw new Error('Timesheet fetch failed — keep Workspace tab open');
        const summary = parseTimesheetSummary(data);
        wsLog('timesheet parsed (tab):', summary.totalHours, 'entries:', summary.entries.length);
        return summary;
    }

    const body = buildTimesheetsBody(auth.csrf);
    let data;

    try {
        data = await postWorkspaceApi(
            WORKSPACE_TIMESHEETS_URL,
            body,
            WORKSPACE_TIMESHEETS_URL,
            auth
        );
    } catch (bgError) {
        wsWarn('background timesheets fetch failed:', bgError.message);
        data = await postViaWorkspaceTab('timesheet');
        if (!data) throw bgError;
    }

    const summary = parseTimesheetSummary(data);
    wsLog('timesheet parsed:', summary.totalHours, 'entries:', summary.entries.length, 'running:', !!summary.runningEntry);
    return summary;
}

async function fetchTasksTableRaw(auth) {
    if (auth.tabOnly) {
        const data = await postViaWorkspaceTab('tasks');
        if (!data) throw new Error('Tasks fetch failed — keep Workspace tab open');
        return data;
    }

    const body = buildTasksBody(auth.csrf);
    try {
        return await postWorkspaceApi(
            `${WORKSPACE_BASE}/admin/tasks/table`,
            body,
            `${WORKSPACE_BASE}/admin/tasks`,
            auth
        );
    } catch (bgError) {
        wsWarn('background tasks fetch failed:', bgError.message);
        const data = await postViaWorkspaceTab('tasks');
        if (!data) throw bgError;
        return data;
    }
}

async function fetchTasksData(auth) {
    const data = await fetchTasksTableRaw(auth);
    const activeTimer = parseActiveTimer(data);
    const tasksList = parseTasksList(data);
    wsLog('tasks parsed:', tasksList.length, 'active:', activeTimer?.taskName || 'none');
    return { activeTimer, tasksList };
}

async function fetchActiveTimerTask(auth) {
    const { activeTimer } = await fetchTasksData(auth);
    return activeTimer;
}

async function fetchWorkspaceData() {
    wsLog('fetchWorkspaceData start');

    let auth = await getWorkspaceAuth();

    if (!auth.success) {
        const tab = await getWorkspaceTab();
        const csrf = await getCsrfFromWorkspaceTab();
        if (tab && csrf) {
            wsLog('using tab-only auth fallback');
            auth = { success: true, csrf, cookieHeader: '', tabOnly: true, hasSession: false };
        } else {
            wsWarn('auth failed:', auth.error, auth.debug);
            return { success: false, error: auth.error, debug: auth.debug };
        }
    }

    if (API_ENABLED && auth.hasSession && !auth.tabOnly) {
        const apiResult = await apiGetWorkspaceStatus();
        if (apiResult.success && apiResult.timesheet) {
            const { timesheet, activeTimer, tasksList } = apiResult;
            await chrome.storage.local.set({
                workspaceTimesheet: timesheet,
                workspaceActiveTimer: activeTimer,
                workspaceTasksList: tasksList,
                lastWorkspaceSync: timesheet?.syncedAt || new Date().toISOString()
            });
            wsLog('fetchWorkspaceData via API success');
            return { success: true, timesheet, activeTimer, tasksList };
        }
        wsWarn('API workspace fetch failed, falling back local:', apiResult.error);
    }

    try {
        const [timesheet, tasksData] = await Promise.all([
            fetchTimesheetsToday(auth),
            fetchTasksData(auth)
        ]);

        const { activeTimer, tasksList } = tasksData;

        await chrome.storage.local.set({
            workspaceTimesheet: timesheet,
            workspaceActiveTimer: activeTimer,
            workspaceTasksList: tasksList,
            lastWorkspaceSync: timesheet.syncedAt
        });

        wsLog('fetchWorkspaceData success', {
            totalHours: timesheet.totalHours,
            activeTimer: activeTimer?.taskName || null,
            tasksCount: tasksList.length
        });

        return { success: true, timesheet, activeTimer, tasksList };
    } catch (error) {
        wsWarn('fetchWorkspaceData error:', error.message);
        return { success: false, error: error.message };
    }
}

function handleWorkspaceMessage(message, sendResponse) {
    if (message.type === 'FETCH_WORKSPACE_DATA') {
        fetchWorkspaceData().then(sendResponse);
        return true;
    }

    if (message.type === 'GET_WORKSPACE_CACHE') {
        chrome.storage.local.get([
            'workspaceTimesheet',
            'workspaceActiveTimer',
            'workspaceTasksList',
            'lastWorkspaceSync'
        ], sendResponse);
        return true;
    }

    if (message.type === 'START_WORKSPACE_TIMER') {
        startWorkspaceTimer(message.taskId, message.note || '').then(sendResponse);
        return true;
    }

    if (message.type === 'UPDATE_WORKSPACE_ALARM_INTERVAL') {
        const minutes = message.minutes || 15;
        chrome.alarms.clear('workspace_timer_monitor', () => {
            chrome.alarms.create('workspace_timer_monitor', { periodInMinutes: minutes });
        });
        sendResponse({ success: true });
        return true;
    }

    return false;
}

function isLunchBreak() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return minutes >= 13 * 60 && minutes < 14 * 60;
}

function isWeekdayWorkHours() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;

    const minutes = now.getHours() * 60 + now.getMinutes();
    const start = 10 * 60;
    const end = 21 * 60;
    return minutes >= start && minutes < end;
}

function findTodayKekaEntry(scrapedAttendance) {
    return resolveTodayEntry(scrapedAttendance);
}

function hasKekaInToday(scrapedAttendance) {
    if (!scrapedAttendance?.entries) return false;
    const todayEntry = findTodayKekaEntry(scrapedAttendance);
    if (!todayEntry) return false;

    if (todayEntry.inOutArray?.length) {
        return todayEntry.inOutArray.some(s => s.type === 'IN' && s.time && s.time !== 'MISSING');
    }

    return !!(todayEntry.checkIn && todayEntry.checkIn !== 'MISSING');
}

function getTodayDateString() {
    return new Date().toDateString();
}

async function resetWorkspaceDailyFlags() {
    const today = getTodayDateString();
    const data = await chrome.storage.local.get([
        'lastNotificationResetDate',
        'workspaceStopAlertSentDate'
    ]);

    if (data.lastNotificationResetDate !== today) {
        await chrome.storage.local.set({
            workspaceStopAlertSentDate: '',
            lastNotificationResetDate: today
        });
    }
}

function canSendStartAlert(lastAlertAt, intervalMinutes) {
    const intervalMs = Math.max(1, intervalMinutes || 15) * 60 * 1000;
    return Date.now() - (lastAlertAt || 0) >= intervalMs;
}

async function checkWorkspaceTimerAlerts() {
    await resetWorkspaceDailyFlags();

    const settings = await chrome.storage.local.get({
        workspaceAlertsEnabled: true,
        scrapedAttendance: null,
        workspaceAlertInterval: 15,
        lastWorkspaceStartAlertAt: 0,
        workspaceStopAlertSentDate: '',
        notificationsEnabled: true,
        language: 'en'
    });

    if (settings.workspaceAlertsEnabled === false) {
        wsLog('alerts skipped: workspaceAlertsEnabled off');
        return;
    }

    if (API_ENABLED) {
        const apiResult = await apiCheckAlerts({
            language: settings.language || 'en',
            notificationsEnabled: settings.notificationsEnabled !== false,
            workspaceAlertsEnabled: settings.workspaceAlertsEnabled !== false,
            workspaceAlertInterval: settings.workspaceAlertInterval || 15,
            scrapedAttendance: settings.scrapedAttendance
        });
        if (apiResult.success && apiResult.alert) {
            wsLog('dispatching alert via API:', apiResult.alert.id);
            await dispatchTrackerAlert(apiResult.alert);
            return;
        }
        if (apiResult.skipped) return;
    }

    if (!isWeekdayWorkHours()) {
        wsLog('alerts skipped: outside weekday work hours (10am–9pm)');
        return;
    }

    const result = await fetchWorkspaceData();
    if (!result.success) {
        wsWarn('alerts skipped: fetchWorkspaceData failed', result.error);
        return;
    }

    const { timesheet, activeTimer } = result;
    const today = getTodayDateString();
    const hasKekaIn = hasKekaInToday(settings.scrapedAttendance);
    const intervalMinutes = settings.workspaceAlertInterval || 15;

    // Start-timer reminder: Keka IN, no workspace timer running, repeats every interval
    if (hasKekaIn && !activeTimer && !isLunchBreak() && canSendStartAlert(settings.lastWorkspaceStartAlertAt, intervalMinutes)) {
        await chrome.storage.local.set({ lastWorkspaceStartAlertAt: Date.now() });
        const lang = await getAlertLocale();
        wsLog('dispatching workspace_start_timer alert');
        await dispatchTrackerAlert({
            id: 'workspace_start_timer',
            variant: 'action',
            title: alertT('alert_ws_start_title', lang),
            label: alertT('alert_reminder_label', lang),
            message: alertT('alert_ws_start_message', lang),
            actions: [
                { id: 'open_workspace', label: alertT('alert_open_workspace', lang), primary: true },
                { id: 'dismiss', label: alertT('alert_dismiss', lang) }
            ]
        });
        return;
    }

    if (hasKekaIn && !activeTimer && !canSendStartAlert(settings.lastWorkspaceStartAlertAt, intervalMinutes)) {
        wsLog('start alert cooldown active, next in', intervalMinutes, 'min');
    } else if (!hasKekaIn) {
        wsLog('start alert skipped: no Keka IN today');
    }

    // Stop-timer / EOD reminder: timer still running after 8h 5m (once per day)
    const totalHours = timesheet?.totalDecimal || 0;
    if (
        activeTimer &&
        totalHours >= STOP_TIMER_THRESHOLD_HOURS &&
        settings.workspaceStopAlertSentDate !== today
    ) {
        await chrome.storage.local.set({ workspaceStopAlertSentDate: today });
        const lang = await getAlertLocale();
        let suggestedMessage = null;
        if (typeof computeSmartEodSuggestion === 'function') {
            suggestedMessage = await computeSmartEodSuggestion();
        }
        await dispatchTrackerAlert({
            id: 'workspace_stop_timer',
            variant: 'eod',
            title: alertT('alert_ws_stop_title', lang),
            label: alertT('eod_modal_label', lang),
            message: `${alertT('alert_ws_stop_message', lang)} (${timesheet.totalHours} logged)`,
            suggestedMessage,
            actions: []
        });
    }
}

function setupWorkspaceTimerMonitor() {
    chrome.storage.local.get({ workspaceAlertInterval: 15 }, (data) => {
        const minutes = data.workspaceAlertInterval || 15;
        chrome.alarms.create('workspace_timer_monitor', { periodInMinutes: minutes });
    });
}

function initWorkspaceModule() {
    setupWorkspaceTimerMonitor();
    checkWorkspaceTimerAlerts();

    let workspaceTabSyncTimer = null;
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status !== 'complete') return;
        if (!tab.url?.startsWith(WORKSPACE_ORIGIN)) return;
        clearTimeout(workspaceTabSyncTimer);
        workspaceTabSyncTimer = setTimeout(() => {
            getWorkspaceAuth()
                .then((auth) => {
                    if (auth.success) {
                        wsLog('workspace session synced after tab load');
                    }
                })
                .catch((err) => wsWarn('workspace tab sync failed:', err.message));
        }, 1500);
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'workspace_timer_monitor') {
            checkWorkspaceTimerAlerts();
        }
    });
}

initWorkspaceModule();
