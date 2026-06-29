// Background service worker
importScripts('../config.js');
importScripts('../shared/attendance-date.js');
importScripts('api-client.js');
importScripts('api-sync.js');
importScripts('eod.js');
importScripts('alerts.js');
importScripts('workspace.js');

// Handle extension icon click to open moveable window
chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
        url: chrome.runtime.getURL('popup/popup.html'),
        type: 'popup',
        width: 480,
        height: 720
    });
});

// ============================================
// AUTO TOKEN CAPTURE FROM NETWORK REQUESTS
// ============================================

let tokenCaptured = false; // Flag to capture only once per session
let lastCapturedToken = null; // Store last captured token to avoid duplicates

// Intercept network requests to capture Authorization token
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        // Quick synchronous check first
        if (tokenCaptured) {
            return; // Already captured, skip
        }

        for (let header of details.requestHeaders) {
            if (header.name.toLowerCase() === 'authorization' && header.value.startsWith('Bearer ')) {
                const token = header.value.replace('Bearer ', '').trim();

                // Only save if it's a valid JWT token and different from last captured
                if (token && token.startsWith('eyJ') && token !== lastCapturedToken) {
                    // Set flag immediately to prevent race conditions
                    tokenCaptured = true;
                    lastCapturedToken = token;

                    // console.log('🔥 Keka Token Auto-Captured!');
                    // console.log('Token preview:', token.substring(0, 50) + '...');

                    // Save token
                    chrome.storage.local.set({
                        kekaAuthToken: token,
                        tokenExtractedAt: new Date().toISOString(),
                        tokenSource: 'Auto-captured from network'
                    }, () => {
                        syncTokenToCloud(token, 'Auto-captured from network');
                    });

                    break; // Stop checking headers
                }
            }
        }
    },
    { urls: ['https://*.keka.com/*'] },
    ['requestHeaders']
);

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'IN_RECORDED') {
        handleInTime(message.inTime);
    } else if (message.type === 'OUT_RECORDED') {
        handleOutTime(message.outTime);
    } else if (message.type === 'ATTENDANCE_SCRAPED') {
        handleScrapedData(message.data);
    } else if (message.type === 'UPDATE_NOTIFICATIONS') {
        updateNotificationAlarms(message.notifications);
        // Store default notification messages if provided
        if (message.defaultNotifications) {
            chrome.storage.local.set({ defaultNotifications: message.defaultNotifications });
        }
        sendResponse({ success: true });
        return true; // Keep channel open for async response
    } else if (message.type === 'TEST_NOTIFICATION') {
        getAlertLocale().then(async (lang) => {
            if (API_ENABLED) {
                const apiResult = await apiTestAlert(lang);
                if (apiResult.success && apiResult.alert) {
                    await dispatchTrackerAlert(apiResult.alert);
                    sendResponse({ success: true });
                    return;
                }
            }
            dispatchTrackerAlert({
                id: 'test',
                variant: 'info',
                title: alertT('alert_test_title', lang),
                label: alertT('alert_reminder_label', lang),
                message: alertT('alert_test_message', lang),
                actions: [{ id: 'dismiss', label: alertT('alert_dismiss', lang) }]
            }).then(() => sendResponse({ success: true }));
        });
        return true;
    } else if (message.type === 'SETUP_DEFAULT_NOTIFICATIONS') {
        setupDefaultNotifications(message.effectiveTime, message.grossTime, message.effectiveMessage, message.grossMessage, message.isEarlyEntry);
        sendResponse({ success: true });
        return true;
    } else if (message.type === 'FETCH_ATTENDANCE_API') {
        fetchAttendanceFromAPI().then(result => {
            sendResponse(result);
        });
        return true; // Keep channel open for async response
    } else if (message.type === 'UPDATE_TOKEN') {
        // Manual token update from settings
        chrome.storage.local.set({
            kekaAuthToken: message.token,
            tokenExtractedAt: new Date().toISOString()
        }, () => {
            syncTokenToCloud(message.token, 'Manual update');
            sendResponse({ success: true });
        });
        return true;
    } else if (typeof handleEodMessage === 'function' && handleEodMessage(message, sendResponse)) {
        return true;
    } else if (typeof handleWorkspaceMessage === 'function' && handleWorkspaceMessage(message, sendResponse)) {
        return true;
    }
});

// Handle scraped attendance data
function handleScrapedData(data) {

    // Find today's entry
    const today = new Date();
    const todayDay = today.getDate();
    const todayMonth = today.toLocaleString('en-US', { month: 'short' });

    const todayEntry = data.entries.find(entry => {
        if (!entry.date) return false;
        const entryDate = entry.date.toLowerCase();
        return entryDate.includes(todayDay.toString()) &&
            entryDate.includes(todayMonth.toLowerCase());
    });

    if (todayEntry && todayEntry.checkIn) {
        // Parse IN time
        const inTime = parseKekaTimeInBackground(todayEntry.checkIn);
        if (inTime) {
            handleInTime(inTime.toISOString());
        }
    }
}

// Parse Keka time in background
function parseKekaTimeInBackground(timeStr) {
    if (!timeStr || timeStr === 'MISSING') return null;

    const today = new Date();
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);

    if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseInt(timeMatch[3]);
        const period = timeMatch[4].toUpperCase();

        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;

        today.setHours(hours, minutes, seconds, 0);
        return today;
    }

    return null;
}

// Handle IN time recording
function handleInTime(inTime) {
    const inDate = new Date(inTime);

    // Check if entry was before 10 AM
    const tenAM = new Date(inDate);
    tenAM.setHours(10, 0, 0, 0);
    const isEarlyEntry = inDate < tenAM;

    // Calculate exit time based on entry time and 7 PM rule
    let exitTime;
    if (isEarlyEntry) {
        // If entered before 10 AM, target exit is 7 PM
        exitTime = new Date(inDate);
        exitTime.setHours(19, 0, 0, 0); // 7 PM
    } else {
        // If entered after 10 AM, use 9-hour rule
        exitTime = new Date(inDate.getTime() + 9 * 60 * 60 * 1000);
    }

    // Calculate notification time (10 minutes before exit)
    const notificationTime = new Date(exitTime.getTime() - 10 * 60 * 1000);

    // Store exit time
    chrome.storage.local.set({ exitTime: exitTime.toISOString() });

    // Clear any existing alarms
    chrome.alarms.clear('exitReminder');

    // Set alarm for notification
    const now = new Date();
    if (notificationTime > now) {
        const delayInMinutes = (notificationTime - now) / (1000 * 60);
        chrome.alarms.create('exitReminder', {
            delayInMinutes: delayInMinutes
        });
    }

    // Save to history
    saveToHistory(inTime, null);
}

// Handle OUT time recording
function handleOutTime(outTime) {
    chrome.storage.local.get(['inTime', 'currentDate'], (data) => {
        if (data.inTime) {
            saveToHistory(data.inTime, outTime);
        }
    });
}

// Save to history log
function saveToHistory(inTime, outTime) {
    chrome.storage.local.get(['history'], (result) => {
        const history = result.history || [];
        const today = new Date().toDateString();

        // Check if today's entry exists
        const existingIndex = history.findIndex(entry => entry.date === today);

        const entry = {
            date: today,
            inTime: inTime,
            outTime: outTime,
            grossHours: outTime ? calculateHours(inTime, outTime) : null
        };

        if (existingIndex >= 0) {
            history[existingIndex] = entry;
        } else {
            history.unshift(entry);
        }

        // Keep only last 30 days
        const trimmedHistory = history.slice(0, 30);

        chrome.storage.local.set({ history: trimmedHistory });
    });
}

// Calculate hours between two timestamps
function calculateHours(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const hours = (endDate - startDate) / (1000 * 60 * 60);
    return hours.toFixed(2);
}

// Handle alarm (modal alerts)
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'exitReminder') {
        chrome.storage.local.get(['isEarlyEntry'], async (data) => {
            const isEarlyEntry = data.isEarlyEntry || false;
            const lang = await getAlertLocale();
            const message = isEarlyEntry
                ? alertT('alert_exit_message_early', lang)
                : alertT('alert_exit_message', lang);

            dispatchTrackerAlert({
                id: 'exitReminder',
                variant: 'info',
                title: alertT('alert_exit_title', lang),
                label: alertT('alert_reminder_label', lang),
                message,
                actions: [{ id: 'dismiss', label: alertT('alert_dismiss', lang) }]
            });
        });
    } else if (alarm.name === 'check_effective_hours') {
        // Check if effective hours reached 8
        checkEffectiveHoursAndNotify();
    } else if (alarm.name === 'target_exit_notification') {
        // Check if BOTH conditions are met: 9 gross hours AND 8 effective hours
        checkTargetExitAndNotify();
    } else if (alarm.name === 'check_target_exit') {
        // Periodic check for target exit conditions
        checkTargetExitAndNotify();
    } else if (alarm.name.startsWith('notification_')) {
        const index = parseInt(alarm.name.split('_')[1]);
        chrome.storage.local.get(['notifications'], async (data) => {
            const notifications = data.notifications || [];
            if (notifications[index]) {
                const lang = await getAlertLocale();
                dispatchTrackerAlert({
                    id: alarm.name,
                    variant: 'info',
                    title: alertT('alert_reminder_label', lang),
                    label: alertT('alert_reminder_label', lang),
                    message: notifications[index].description,
                    actions: [{ id: 'dismiss', label: alertT('alert_dismiss', lang) }]
                });
            }
        });
    }
});

// Calculate effective hours from attendance data
function calculateEffectiveHours(todayEntry) {
    if (!todayEntry || !todayEntry.inOutArray) {
        return 0;
    }

    const validSwipes = todayEntry.inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');
    let totalEffectiveSeconds = 0;

    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseKekaTimeInBackground(swipe.time);

        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseKekaTimeInBackground(validSwipes[i + 1].time);
                if (outTime) {
                    totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                }
            }
        }
    }

    // If last swipe is IN, add time until now
    const lastSwipe = validSwipes[validSwipes.length - 1];
    if (lastSwipe && lastSwipe.type === 'IN') {
        const lastInTime = parseKekaTimeInBackground(lastSwipe.time);
        if (lastInTime) {
            const now = new Date();
            totalEffectiveSeconds += (now - lastInTime) / 1000;
        }
    }

    return totalEffectiveSeconds / 3600; // Return hours
}

// Check effective hours and send notification when 8h is reached
async function checkEffectiveHoursAndNotify() {
    chrome.storage.local.get(['scrapedAttendance', 'effective8hNotificationSent'], (data) => {
        // Skip if notification already sent today
        if (data.effective8hNotificationSent) {
            chrome.alarms.clear('check_effective_hours');
            return;
        }

        if (!data.scrapedAttendance || !data.scrapedAttendance.entries) {
            return;
        }

        const todayEntry = findTodayEntry(data.scrapedAttendance.entries);

        const effectiveHours = calculateEffectiveHours(todayEntry);

        // If effective hours >= 8, send notification
        if (effectiveHours >= 8) {
            // Set flag IMMEDIATELY to prevent race conditions
            chrome.storage.local.set({ effective8hNotificationSent: true }, () => {
                // Stop monitoring for 8h
                chrome.alarms.clear('check_effective_hours');

                // Then send notification
                chrome.storage.local.get(['defaultNotificationMessages'], async (msgData) => {
                    const lang = await getAlertLocale();
                    const message = msgData.defaultNotificationMessages?.effective
                        || alertT('alert_effective_title', lang) + '! Great work!';
                    dispatchTrackerAlert({
                        id: 'effective_8h',
                        variant: 'info',
                        title: alertT('alert_effective_title', lang),
                        label: alertT('alert_reminder_label', lang),
                        message,
                        actions: [{ id: 'dismiss', label: alertT('alert_dismiss', lang) }]
                    });
                });
            });
        }
    });
}

// Check if target exit conditions are met (for early entries: 7 PM + 8h effective, for late entries: 9h gross + 8h effective)
async function checkTargetExitAndNotify() {
    chrome.storage.local.get(['scrapedAttendance', 'targetGrossTime', 'targetExitNotificationSent', 'isEarlyEntry'], (data) => {
        // Skip if notification already sent today
        if (data.targetExitNotificationSent) {
            chrome.alarms.clear('check_target_exit');
            chrome.alarms.clear('target_exit_notification');
            return;
        }

        if (!data.scrapedAttendance || !data.scrapedAttendance.entries || !data.targetGrossTime) {
            return;
        }

        const todayEntry = findTodayEntry(data.scrapedAttendance.entries);

        if (!todayEntry || !todayEntry.inOutArray || todayEntry.inOutArray.length === 0) {
            return;
        }

        // Check condition 1: Has target time passed?
        const targetTime = new Date(data.targetGrossTime);
        const now = new Date();
        const targetTimeReached = now >= targetTime;

        // Check condition 2: Has 8 effective hours been completed?
        const effectiveHours = calculateEffectiveHours(todayEntry);
        const effectiveHoursComplete = effectiveHours >= 8;

        // For early entries (before 10 AM): 7 PM + 8h effective
        // For late entries (after 10 AM): 9h gross + 8h effective
        const isEarlyEntry = data.isEarlyEntry || false;

        let canExit = false;
        if (isEarlyEntry) {
            // Early entry: can exit at 7 PM if 8h effective is complete
            canExit = targetTimeReached && effectiveHoursComplete;
        } else {
            // Late entry: can exit after 9h gross if 8h effective is complete
            canExit = targetTimeReached && effectiveHoursComplete;
        }

        if (canExit) {
            // Set flag IMMEDIATELY to prevent race conditions
            chrome.storage.local.set({ targetExitNotificationSent: true }, () => {
                // Stop all monitoring
                chrome.alarms.clear('check_effective_hours');
                chrome.alarms.clear('check_target_exit');
                chrome.alarms.clear('target_exit_notification');

                // Then send notification
                chrome.storage.local.get(['defaultNotificationMessages'], async (msgData) => {
                    const lang = await getAlertLocale();
                    const message = msgData.defaultNotificationMessages?.gross
                        || (isEarlyEntry
                            ? alertT('alert_exit_message_early', lang)
                            : alertT('alert_target_exit_title', lang) + '! You can leave now.');
                    dispatchTrackerAlert({
                        id: 'target_exit',
                        variant: 'info',
                        title: alertT('alert_target_exit_title', lang),
                        label: alertT('alert_reminder_label', lang),
                        message,
                        actions: [{ id: 'dismiss', label: alertT('alert_dismiss', lang) }]
                    });
                });
            });
        }
    });
}

// Check on startup if we need to set alarm
chrome.runtime.onStartup.addListener(() => {
    checkAndSetAlarm();
    resetDailyNotificationFlags();
});

chrome.runtime.onInstalled.addListener(() => {
    checkAndSetAlarm();
    resetDailyNotificationFlags();
});

function checkAndSetAlarm() {
    chrome.storage.local.get(['inTime', 'currentDate', 'outTime'], (data) => {
        const today = new Date().toDateString();

        // If IN time exists for today and OUT is not recorded
        if (data.inTime && data.currentDate === today && !data.outTime) {
            const inDate = new Date(data.inTime);
            const exitTime = new Date(inDate.getTime() + 9 * 60 * 60 * 1000);
            const notificationTime = new Date(exitTime.getTime() - 10 * 60 * 1000);
            const now = new Date();

            if (notificationTime > now) {
                const delayInMinutes = (notificationTime - now) / (1000 * 60);
                chrome.alarms.create('exitReminder', {
                    delayInMinutes: delayInMinutes
                });
            }
        }
    });
}

// Reset notification flags at the start of a new day
function resetDailyNotificationFlags() {
    chrome.storage.local.get(['lastNotificationResetDate'], (data) => {
        const today = new Date().toDateString();

        if (data.lastNotificationResetDate !== today) {
            // New day, reset all notification flags
            chrome.storage.local.set({
                effective8hNotificationSent: false,
                targetExitNotificationSent: false,
                lastWorkspaceStartAlertAt: 0,
                workspaceStopAlertSentDate: '',
                lastNotificationResetDate: today
            });
        }
    });
}


// Update notification alarms
function updateNotificationAlarms(notifications) {

    // Clear all custom notification alarms (keep exitReminder)
    chrome.alarms.getAll((alarms) => {
        alarms.forEach(alarm => {
            if (alarm.name.startsWith('notification_')) {
                chrome.alarms.clear(alarm.name);
            }
        });

        // Create new alarms
        notifications.forEach((notif, index) => {
            const [hours, minutes] = notif.time.split(':');
            const now = new Date();
            const alarmTime = new Date();
            alarmTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

            // If time has passed today, set for tomorrow
            if (alarmTime <= now) {
                alarmTime.setDate(alarmTime.getDate() + 1);
            }

            const delayInMinutes = (alarmTime - now) / (1000 * 60);

            chrome.alarms.create(`notification_${index}`, {
                when: alarmTime.getTime(),
                periodInMinutes: 24 * 60 // Repeat daily
            });
        });
    });
}

// Load and set up notifications on startup
chrome.runtime.onStartup.addListener(() => {
    setupNotificationsOnStartup();
});

chrome.runtime.onInstalled.addListener(() => {
    setupNotificationsOnStartup();
});

function setupNotificationsOnStartup() {
    chrome.storage.local.get(['notifications'], (data) => {
        if (data.notifications && data.notifications.length > 0) {
            updateNotificationAlarms(data.notifications);
        }
    });
}


// Setup default notifications for 8h effective and target exit (9h gross + 8h effective OR 7 PM for early entries)
function setupDefaultNotifications(effectiveTimeStr, grossTimeStr, effectiveMessage, grossMessage, isEarlyEntry) {
    const now = new Date();

    // Store messages and target times for later use
    chrome.storage.local.set({
        defaultNotificationMessages: {
            effective: effectiveMessage || '🎉 8 Hours Complete (Effective)! Great work!',
            gross: grossMessage || (isEarlyEntry ? '🎯 7 PM Freedom Time! You can leave now! 🚀' : '🎯 Target Exit Time! You can leave now.')
        },
        targetEffectiveTime: effectiveTimeStr,
        targetGrossTime: grossTimeStr,
        isEarlyEntry: isEarlyEntry || false
    });

    // Clear existing default alarms
    chrome.alarms.clear('effective_8h_complete');
    chrome.alarms.clear('target_exit_notification');
    chrome.alarms.clear('check_target_exit');

    // Start monitoring effective hours for 8h notification
    startEffectiveHoursMonitoring();

    // Start monitoring for target exit
    const grossTime = new Date(grossTimeStr);
    if (grossTime > now) {
        // Set alarm at the target exit time to check conditions
        chrome.alarms.create('target_exit_notification', {
            when: grossTime.getTime()
        });

        // Also check every minute after 7.5 hours in case effective hours complete after target time
        chrome.alarms.create('check_target_exit', {
            delayInMinutes: 1,
            periodInMinutes: 1
        });
    }
}

// Monitor effective hours and trigger notification when 8h is reached
function startEffectiveHoursMonitoring() {
    // Clear any existing monitoring interval
    chrome.alarms.clear('check_effective_hours');

    // Check every minute if effective hours reached 8
    chrome.alarms.create('check_effective_hours', {
        delayInMinutes: 1,
        periodInMinutes: 1
    });
}


// async function fetchKekaData() {
//     const token = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjFBRjQzNjk5RUE0NDlDNkNCRUU3NDZFMjhDODM5NUIyMEE0MUNFMTgiLCJ4NXQiOiJHdlEybWVwRW5HeS01MGJpaklPVnNncEJ6aGciLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL2FwcC5rZWthLmNvbSIsIm5iZiI6MTc2MzA5ODIyOCwiaWF0IjoxNzYzMDk4MjI4LCJleHAiOjE3NjMxODQ2MjgsImF1ZCI6WyJrZWthaHIuYXBpIiwiaGlyby5hcGkiLCJodHRwczovL2FwcC5rZWthLmNvbS9yZXNvdXJjZXMiXSwic2NvcGUiOlsib3BlbmlkIiwia2VrYWhyLmFwaSIsImhpcm8uYXBpIiwib2ZmbGluZV9hY2Nlc3MiXSwiYW1yIjpbIm1mYSJdLCJjbGllbnRfaWQiOiI5ODdjYzk3MS1mYzIyLTQ0NTQtOTlmOS0xNmMwNzhmYTdmZjYiLCJzdWIiOiI0Zjg4NmZiMC0wODQ2LTRhZWUtYjY3NC0wOGIwZDljODEzZDQiLCJhdXRoX3RpbWUiOjE3NjMwMjUwNDYsImlkcCI6ImxvY2FsIiwidGVuYW50X2lkIjoiYzk2NDBlOGMtNzkwNi00Nzc1LWEzM2MtZTQxMDgzMWFhMTYwIiwidGVuYW50aWQiOiJjOTY0MGU4Yy03OTA2LTQ3NzUtYTMzYy1lNDEwODMxYWExNjAiLCJzdWJkb21haW4iOiJhY3F1YWludC5rZWthLmNvbSIsInVzZXJfaWQiOiIzOTZlMTMxOS1lMjQ1LTQ2MmEtODVkMS1kODg0Y2FkOTc3MDMiLCJ1c2VyX2lkZW50aWZpZXIiOiIzOTZlMTMxOS1lMjQ1LTQ2MmEtODVkMS1kODg0Y2FkOTc3MDMiLCJ1c2VybmFtZSI6Im5lZWwucGF0ZWxAYWNxdWFpbnRzb2Z0LmNvbSIsImVtYWlsIjoibmVlbC5wYXRlbEBhY3F1YWludHNvZnQuY29tIiwiYXV0aGVudGljYXRpb25fdHlwZSI6IjEiLCJzaWQiOiI2MjBEQUFCQUI5MkE1NDcwNjg4RERBMjc3QjJERjE0RSIsImp0aSI6IjBGNTJDODUwNzMzRDkzMjBENDEyNEM1QzUwNkVERDUwIn0.UU8Wj4Wwt2GNh2tTAWgjiCt52pyLDN7-65E5JYdbX5EtasuVtsFb0REPcUY3u0NekHCtSlITQ10LgN9pwyB4xZ8vJQLixB14oM1umHZfSKIYSvRiCQd2D2Y7C1JeYOL777oVBcrgxDMaTRMz9EwQ0AxnuenvIlhrt36HkhlAk1RUZ867MiBd1-eTZtDgkPy27wfpf1ObTXNDIt3XyjcqnTrv5-Fb7uceQWGtJbmXeHZJvB8Nnnb2AOYLh7-TZXcSxXLRsLxmTnO8ktMiRA7rJb4rfhO21mdyMzls-j7yyO41kLpFxF34GY3dZ7ncqoPM5KZEVa0M14sBBaBOcr9Y6g";

//     const res = await fetch("https://acquaint.keka.com/k/attendance/api/mytime/attendance/summary", {
//         method: "GET",
//         headers: {
//             "Authorization": `Bearer ${token}`,
//             "Content-Type": "application/json"
//         },
//         credentials: "include"
//     });

//     const data = await res.json();
//     console.log("Keka API data:", data);
// }

// fetchKekaData();


// Fetch attendance data from Keka API (works from anywhere)
async function fetchAttendanceFromAPI() {

    try {
        // Get token from storage (auto-captured or manually set)
        const stored = await chrome.storage.local.get(['kekaAuthToken', 'tokenSource']);
        const token = stored.kekaAuthToken;

        if (!token) {
            return {
                success: false,
                error: 'No authentication token found. Please visit Keka website to auto-capture token, or add it manually in Settings.'
            };
        }

        if (API_ENABLED) {
            const apiResult = await apiGetAttendanceToday();
            if (apiResult.success && apiResult.attendance) {
                const attendanceData = apiResult.attendance;
                chrome.storage.local.set({
                    scrapedAttendance: attendanceData,
                    lastScrapeTime: new Date().toISOString()
                });
                if (attendanceData.entries?.length) {
                    syncAttendanceToCloud(token, null);
                    return { success: true, data: attendanceData, source: 'API' };
                }
            }
        }

        const response = await fetch('https://acquaint.keka.com/k/attendance/api/mytime/attendance/summary', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        // Handle 401 Unauthorized - token expired
        if (response.status === 401) {
            console.error('❌ Token expired (401 Unauthorized)');

            // Clear the expired token and reset capture flag
            chrome.storage.local.remove('kekaAuthToken');
            tokenCaptured = false;
            lastCapturedToken = null;

            return {
                success: false,
                error: '🔑 Token expired! Please visit Keka website to refresh your token automatically.'
            };
        }

        if (!response.ok) {
            console.error('API request failed:', response.status);
            return {
                success: false,
                error: `API request failed with status ${response.status}`
            };
        }

        const data = await response.json();

        // Get today's date (local timezone)
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const todayStr = `${year}-${month}-${day}`;

        // Get date 7 days ago for filtering recent entries
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getDate()).padStart(2, '0')}`;

        const attendanceData = {
            scrapedAt: new Date().toISOString(),
            source: 'API',
            entries: []
        };

        // Parse and filter for last 7 days (including today)
        if (data.data && Array.isArray(data.data)) {

            data.data.forEach(item => {
                const itemDate = item.attendanceDate ? item.attendanceDate.split('T')[0] : null;

                // Include entries from last 7 days
                if (itemDate && itemDate >= sevenDaysAgoStr && itemDate <= todayStr) {
                    const parsedEntry = parseApiEntry(item);
                    attendanceData.entries.push(parsedEntry);
                }
            });

            attendanceData.entries.sort((a, b) =>
                (b.attendanceDate || '').localeCompare(a.attendanceDate || '')
            );
        }

        if (attendanceData.entries.length === 0) {
            // Still save the data even if no entries
            chrome.storage.local.set({
                scrapedAttendance: attendanceData,
                lastScrapeTime: new Date().toISOString()
            });

            return {
                success: false,
                error: `No attendance data found for the last 7 days. Check if you have any attendance records.`
            };
        }

        // Save to storage
        chrome.storage.local.set({
            scrapedAttendance: attendanceData,
            lastScrapeTime: new Date().toISOString()
        });

        syncAttendanceToCloud(token, data.data);

        return {
            success: true,
            data: attendanceData
        };

    } catch (error) {
        console.error('API fetch error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Parse API entry from actual Keka API response
function parseApiEntry(item) {
    const date = new Date(item.attendanceDate);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const formattedDate = `${dayName}, ${day} ${month}`;

    const attendanceDate = item.attendanceDate ? item.attendanceDate.split('T')[0] : null;
    const entry = {
        attendanceDate,
        date: formattedDate,
        checkIn: null,
        checkOut: null,
        inOutArray: [],
        duration: item.grossHoursInHHMM || null,
        effectiveHours: item.effectiveHoursInHHMM || null,
        status: null,
        shift: item.shiftPolicyName || null,
        shiftStart: null,
        shiftEnd: null,
        late: item.arrivalMessage || null,
        breakDuration: item.breakDurationInHHMM || null,
        totalGrossHours: item.totalGrossHours || 0,
        totalEffectiveHours: item.totalEffectiveHours || 0
    };

    // Format shift times
    if (item.shiftStartTime) {
        const shiftStart = new Date(item.shiftStartTime);
        entry.shiftStart = shiftStart.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    }

    if (item.shiftEndTime) {
        const shiftEnd = new Date(item.shiftEndTime);
        entry.shiftEnd = shiftEnd.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    }

    // Parse time entries (originalTimeEntries has all swipes)
    if (item.originalTimeEntries && Array.isArray(item.originalTimeEntries)) {
        item.originalTimeEntries.forEach(timeEntry => {
            const swipeTime = new Date(timeEntry.timestamp);
            const timeStr = swipeTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });

            // punchStatus: 0 = IN, 1 = OUT, 4 = Auto OUT
            let swipeType;
            if (timeEntry.punchStatus === 0) {
                swipeType = 'IN';
            } else if (timeEntry.punchStatus === 1 || timeEntry.punchStatus === 4) {
                swipeType = 'OUT';
            } else {
                return; // Skip unknown punch status
            }

            const swipeEntry = {
                type: swipeType,
                time: timeStr,
                premise: timeEntry.premiseName || 'Unknown'
            };

            entry.inOutArray.push(swipeEntry);

            // Set first IN and last OUT
            if (swipeType === 'IN' && !entry.checkIn) {
                entry.checkIn = timeStr;
            }
            if (swipeType === 'OUT') {
                entry.checkOut = timeStr;
            }
        });
    }

    // If no OUT found, check if still working
    if (entry.checkIn && !entry.checkOut) {
        entry.checkOut = 'MISSING';
    }

    // Set status based on attendance day status
    if (item.attendanceDayStatus === 1) {
        entry.status = 'Present';
    } else if (item.attendanceDayStatus === 0) {
        entry.status = 'Absent';
    }

    // Check for missing swipes or anomalies
    if (item.isAnomalyDetected) {
        entry.status = 'Anomaly Detected';
    } else if (entry.inOutArray.length > 0 && entry.checkOut === 'MISSING') {
        entry.status = 'Missing Swipe';
    }

    return entry;
}
