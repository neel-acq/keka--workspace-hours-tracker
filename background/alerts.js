// Alert dispatcher — page modal when Chrome is open, OS notification when not

const ALERT_STRINGS = {
    en: {
        alert_dismiss: 'Dismiss',
        alert_open_workspace: 'Open Workspace',
        alert_reminder_label: 'Reminder',
        alert_exit_title: 'Exit Reminder',
        alert_exit_message_early: '10 minutes until 7 PM! Almost freedom time!',
        alert_exit_message: '10 minutes until your exit time!',
        alert_effective_title: '8 Hours Complete',
        alert_target_exit_title: 'Target Exit',
        alert_test_title: 'Test Alert',
        alert_test_message: 'Your alerts are working correctly.',
        alert_ws_start_title: 'Start Workspace Timer',
        alert_ws_start_message: 'You are punched in on Keka but no workspace timer is running.',
        alert_ws_stop_title: 'Stop Workspace Timer',
        alert_ws_stop_message: 'You have logged 8h 5m+. Consider stopping your timer and sending EOD.',
        eod_modal_title: 'Send update to Teams',
        eod_modal_label: 'EOD',
        eod_modal_instruction: 'Select a message to send to your group:',
        eod_custom_toggle: 'Write a Custom Message...',
        eod_send_custom: 'Send Custom Message',
        eod_custom_placeholder: 'Type your message here...',
        eod_suggested_prefix: 'Suggested:'
    },
    gu: {
        alert_dismiss: 'બંધ કરો',
        alert_open_workspace: 'વર્કસ્પેસ ખોલો',
        alert_reminder_label: 'રિમાઇન્ડર',
        alert_exit_title: 'બહાર નીકળવાનો રિમાઇન્ડર',
        alert_exit_message_early: '7 વાગ્યા સુધી 10 મિનિટ! લગભગ છૂટી ગયું!',
        alert_exit_message: 'તમારા લક્ષ્ય સમય સુધી 10 મિનિટ!',
        alert_effective_title: '8 કલાક પૂર્ણ',
        alert_target_exit_title: 'લક્ષ્ય બહાર નીકળવું',
        alert_test_title: 'ટેસ્ટ અલર્ટ',
        alert_test_message: 'તમારા અલર્ટ યોગ્ય રીતે કામ કરે છે.',
        alert_ws_start_title: 'વર્કસ્પેસ ટાઈમર શરૂ કરો',
        alert_ws_start_message: 'તમે કેકામાં IN છો પણ વર્કસ્પેસ ટાઈમર ચાલુ નથી.',
        alert_ws_stop_title: 'વર્કસ્પેસ ટાઈમર બંધ કરો',
        alert_ws_stop_message: 'તમે 8 કલાક 5 મિનિટ+ લોગ કર્યું છે. ટાઈમર બંધ કરો અને EOD મોકલો.',
        eod_modal_title: 'ટીમ્સ પર અપડેટ મોકલો',
        eod_modal_label: 'EOD',
        eod_modal_instruction: 'તમારા ગ્રુપને મોકલવા માટે સંદેશ પસંદ કરો:',
        eod_custom_toggle: 'કસ્ટમ સંદેશ લખો...',
        eod_send_custom: 'કસ્ટમ સંદેશ મોકલો',
        eod_custom_placeholder: 'તમારો સંદેશ અહીં લખો...',
        eod_suggested_prefix: 'સૂચવેલ:'
    },
    hi: {
        alert_dismiss: 'बंद करें',
        alert_open_workspace: 'वर्कस्पेस खोलें',
        alert_reminder_label: 'रिमाइंडर',
        alert_exit_title: 'निकास रिमाइंडर',
        alert_exit_message_early: '7 बजे तक 10 मिनट! लगभग छुट्टी!',
        alert_exit_message: 'आपके लक्ष्य समय तक 10 मिनट!',
        alert_effective_title: '8 घंटे पूरे',
        alert_target_exit_title: 'लक्ष्य निकास',
        alert_test_title: 'टेस्ट अलर्ट',
        alert_test_message: 'आपके अलर्ट सही काम कर रहे हैं।',
        alert_ws_start_title: 'वर्कस्पेस टाइमर शुरू करें',
        alert_ws_start_message: 'आप Keka में IN हैं लेकिन वर्कस्पेस टाइमर नहीं चल रहा।',
        alert_ws_stop_title: 'वर्कस्पेस टाइमर बंद करें',
        alert_ws_stop_message: 'आपने 8 घंटे 5 मिनट+ लॉग किया है। टाइमर बंद करें और EOD भेजें।',
        eod_modal_title: 'Teams पर अपडेट भेजें',
        eod_modal_label: 'EOD',
        eod_modal_instruction: 'अपने ग्रुप को भेजने के लिए संदेश चुनें:',
        eod_custom_toggle: 'कस्टम संदेश लिखें...',
        eod_send_custom: 'कस्टम संदेश भेजें',
        eod_custom_placeholder: 'अपना संदेश यहाँ लिखें...',
        eod_suggested_prefix: 'सुझाव:'
    }
};

const KEKA_ATTENDANCE_URL = 'https://acquaint.keka.com/#/me/attendance/logs';
const NOTIFICATION_PREFIX = 'kht_alert_';

function alertT(key, lang) {
    const l = ALERT_STRINGS[lang] || ALERT_STRINGS.en;
    return l[key] || ALERT_STRINGS.en[key] || key;
}

async function getAlertLocale() {
    const data = await chrome.storage.local.get({ language: 'en' });
    return data.language || 'en';
}

async function buildAlertStrings(lang) {
    const keys = Object.keys(ALERT_STRINGS.en);
    const strings = {};
    keys.forEach((k) => { strings[k] = alertT(k, lang); });
    return strings;
}

function isInjectableAlertUrl(url) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
        return false;
    }
    return url.includes('keka.com') || url.includes('workspace.acquaintsoft.com');
}

async function isBrowserWindowOpen() {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    return windows.length > 0;
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
        };

        const onUpdated = (id, info) => {
            if (id === tabId && info.status === 'complete') {
                finish();
            }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then((tab) => {
            if (tab.status === 'complete') {
                finish();
            }
        }).catch(() => finish());

        setTimeout(finish, timeoutMs);
    });
}

async function findExistingAlertTabs() {
    const [workspaceTabs, kekaTabs, activeTabs] = await Promise.all([
        chrome.tabs.query({ url: 'https://workspace.acquaintsoft.com/*' }),
        chrome.tabs.query({ url: 'https://*.keka.com/*' }),
        chrome.tabs.query({ active: true, lastFocusedWindow: true })
    ]);

    const ordered = [];
    const seen = new Set();

    const add = (tab) => {
        if (tab?.id && !seen.has(tab.id) && isInjectableAlertUrl(tab.url)) {
            seen.add(tab.id);
            ordered.push(tab);
        }
    };

    workspaceTabs.forEach(add);
    kekaTabs.forEach(add);
    activeTabs.forEach(add);

    return ordered;
}

async function trySendAlertToTab(tabId, config) {
    const eodPayload = config.variant === 'eod'
        ? {
            type: 'SHOW_EOD_MODAL',
            reason: config.reason || 'timer_stop',
            suggestedMessage: config.suggestedMessage
        }
        : null;

    try {
        if (eodPayload) {
            await chrome.tabs.sendMessage(tabId, eodPayload);
        } else {
            await chrome.tabs.sendMessage(tabId, {
                type: 'SHOW_TRACKER_ALERT',
                config
            });
        }
        return true;
    } catch (e) {
        try {
            const files = config.variant === 'eod'
                ? [
                    'content/modals/tracker-modal.js',
                    'content/modals/eod-modal.js',
                    'content/modals/modal-bridge.js'
                ]
                : ['content/modals/tracker-modal.js', 'content/modals/modal-bridge.js'];
            await chrome.scripting.insertCSS({
                target: { tabId },
                files: ['content/modals/tracker-modal.css']
            });
            await chrome.scripting.executeScript({ target: { tabId }, files });
            if (eodPayload) {
                await chrome.tabs.sendMessage(tabId, eodPayload);
            } else {
                await chrome.tabs.sendMessage(tabId, { type: 'SHOW_TRACKER_ALERT', config });
            }
            return true;
        } catch (e2) {
            return false;
        }
    }
}

async function openTabInNormalWindow(url) {
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (normalWindows.length > 0) {
        const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
        const tab = await chrome.tabs.create({ url, active: true, windowId: targetWindow.id });
        await chrome.windows.update(targetWindow.id, { focused: true }).catch(() => {});
        return tab;
    } else {
        const newWindow = await chrome.windows.create({ url, type: 'normal', focused: true });
        return newWindow.tabs && newWindow.tabs.length > 0 ? newWindow.tabs[0] : null;
    }
}

async function openTabForAlert(config) {
    const url = config.variant === 'eod'
        ? WORKSPACE_TASKS_URL
        : KEKA_ATTENDANCE_URL;

    const tab = await openTabInNormalWindow(url);
    if (tab) {
        await waitForTabComplete(tab.id);
        await new Promise((r) => setTimeout(r, 400));
    }
    return tab;
}

function getNotificationActions(config) {
    const actions = Array.isArray(config.actions) ? config.actions : [];
    return actions.filter((a) => a.id !== 'dismiss');
}

function getDefaultUrlForAlert(config) {
    if (config.variant === 'eod' || config.id === 'workspace_start_timer' || config.id === 'workspace_stop_timer') {
        return WORKSPACE_TASKS_URL;
    }
    return KEKA_ATTENDANCE_URL;
}

async function showOsNotification(config) {
    const alertId = config.id || 'alert';
    const notifId = `${NOTIFICATION_PREFIX}${alertId}_${Date.now()}`;
    const buttonActions = getNotificationActions(config);

    await chrome.storage.local.set({
        pendingNotificationAlert: {
            alertId: config.id,
            variant: config.variant,
            actions: buttonActions,
            config
        }
    });

    const options = {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icon128.png'),
        title: config.title || 'Keka Hours Tracker',
        message: config.message || '',
        priority: 2
    };

    if (buttonActions.length > 0) {
        options.buttons = buttonActions.map((a) => ({ title: a.label }));
    }

    await chrome.notifications.create(notifId, options);
    return notifId;
}

async function tryShowPageModal(config) {
    const tabs = await findExistingAlertTabs();
    for (const tab of tabs) {
        const sent = await trySendAlertToTab(tab.id, config);
        if (sent) {
            await chrome.windows.update(tab.windowId, { focused: true });
            await chrome.tabs.update(tab.id, { active: true });
            return true;
        }
    }

    const newTab = await openTabForAlert(config);
    return trySendAlertToTab(newTab.id, config);
}

async function dispatchTrackerAlert(alertConfig) {
    const settings = await chrome.storage.local.get({
        notificationsEnabled: true,
        language: 'en'
    });

    if (settings.notificationsEnabled === false) {
        return { success: false, skipped: true };
    }

    const lang = settings.language || 'en';
    const strings = await buildAlertStrings(lang);
    const config = {
        ...alertConfig,
        strings
    };

    const browserOpen = await isBrowserWindowOpen();

    if (!browserOpen) {
        await showOsNotification(config);
        return { success: true, surface: 'notification' };
    }

    const modalShown = await tryShowPageModal(config);
    if (modalShown) {
        return { success: true, surface: 'modal' };
    }

    await showOsNotification(config);
    return { success: true, surface: 'notification' };
}

function handleTrackerAlertAction(message) {
    const { alertId, actionId } = message;

    if (actionId === 'open_workspace' || (alertId === 'workspace_start_timer' && actionId === 'primary')) {
        openTabInNormalWindow(WORKSPACE_TASKS_URL);
        return;
    }

    if (actionId === 'open_keka') {
        openTabInNormalWindow(KEKA_ATTENDANCE_URL);
    }
}

async function handleNotificationClick(notifId) {
    if (!notifId.startsWith(NOTIFICATION_PREFIX)) return;

    const data = await chrome.storage.local.get(['pendingNotificationAlert']);
    const pending = data.pendingNotificationAlert;
    chrome.notifications.clear(notifId);

    const url = pending ? getDefaultUrlForAlert(pending) : KEKA_ATTENDANCE_URL;
    const tab = await openTabInNormalWindow(url);
    if (tab) {
        await waitForTabComplete(tab.id);
        await new Promise((r) => setTimeout(r, 400));

        if (pending?.config) {
            await trySendAlertToTab(tab.id, pending.config);
        }
    }

    await chrome.storage.local.remove('pendingNotificationAlert');
}

async function handleNotificationButton(notifId, buttonIndex) {
    if (!notifId.startsWith(NOTIFICATION_PREFIX)) return;

    const data = await chrome.storage.local.get(['pendingNotificationAlert']);
    const pending = data.pendingNotificationAlert;
    chrome.notifications.clear(notifId);

    if (!pending) return;

    const action = pending.actions?.[buttonIndex];
    if (action) {
        handleTrackerAlertAction({ alertId: pending.alertId, actionId: action.id });
    } else {
        openTabInNormalWindow(getDefaultUrlForAlert(pending));
    }

    await chrome.storage.local.remove('pendingNotificationAlert');
}

function initAlertsModule() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'TRACKER_ALERT_ACTION') {
            handleTrackerAlertAction(message);
            sendResponse({ success: true });
            return true;
        }
        return false;
    });

    chrome.notifications.onClicked.addListener((notifId) => {
        handleNotificationClick(notifId);
    });

    chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
        handleNotificationButton(notifId, buttonIndex);
    });
}

initAlertsModule();
