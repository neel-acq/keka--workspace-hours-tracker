// Popup script - Multi-page Edition

let countdownInterval = null;
let notifications = [];

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    loadTheme();
    loadNotifications();
    checkTokenAndUpdateUI();
    autoFetchWorkspaceData();
    loadData();
    startCountdown();
    initNavigation();
    initPunchCardToggle();
    initSettingsTabs();

    // Event listeners
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    const openKekaBtn = document.getElementById('openKeka');
    if (openKekaBtn) {
        openKekaBtn.addEventListener('click', openKekaWebsite);
    }

    document.getElementById('addNotification').addEventListener('click', addNotification);
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    document.getElementById('testNotification').addEventListener('click', testNotification);
    document.getElementById('refreshShiftData').addEventListener('click', loadShiftData);
    document.getElementById('retryShiftData').addEventListener('click', loadShiftData);
    document.getElementById('darkModeToggle').addEventListener('change', handleDarkModeToggle);
    document.getElementById('notificationsToggle').addEventListener('change', handleNotificationsToggle);
    document.getElementById('autoSyncToggle').addEventListener('change', handleAutoSyncToggle);
    document.getElementById('languageSelect').addEventListener('change', handleLanguageChange);
    document.getElementById('funnyTextToggle').addEventListener('change', handleFunnyTextToggle);


});

// Navigation System
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn[data-page]');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetPage = btn.dataset.page;
            switchPage(targetPage);
        });
    });
}

function switchPage(pageName) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });

    // Remove active from all nav buttons
    document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show target page
    const targetPage = document.getElementById(pageName + 'Page');
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // Activate nav button
    const targetBtn = document.querySelector(`.nav-btn[data-page="${pageName}"]`);
    if (targetBtn) {
        targetBtn.classList.add('active');
    }

    // Load settings page data if switching to settings
    if (pageName === 'settings') {
        loadSettingsPage();
    }

    if (pageName === 'workspace') {
        initWorkspacePage();
    }
}

// Toggle theme
const THEME_ICON_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
const THEME_ICON_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';

function setThemeIcon(isDark) {
    const themeIcon = document.querySelector('#themeToggle .nav-icon');
    if (themeIcon) themeIcon.innerHTML = isDark ? THEME_ICON_SUN : THEME_ICON_MOON;
}

function loadTheme() {
    chrome.storage.local.get(['darkMode'], (result) => {
        if (result.darkMode) {
            document.body.classList.add('dark-mode');
        }
        setThemeIcon(!!result.darkMode);
    });
}

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    setThemeIcon(isDark);
    chrome.storage.local.set({ darkMode: isDark });
}

// Load data from storage
function loadData() {
    chrome.storage.local.get(['scrapedAttendance'], (data) => {
        if (!data.scrapedAttendance) {
            displayNoData();
            return;
        }

        const todayEntry = findTodayEntry(data.scrapedAttendance.entries);

        if (todayEntry) {
            if (todayEntry.inOutArray && todayEntry.inOutArray.length > 0) {
                displayDataFromArray(todayEntry.inOutArray);
                displayInOutList(todayEntry.inOutArray);
            } else if (todayEntry.checkIn) {
                const inTime = parseKekaTime(todayEntry.checkIn);
                const outTime = todayEntry.checkOut && todayEntry.checkOut !== 'MISSING' ? parseKekaTime(todayEntry.checkOut) : null;

                if (inTime) {
                    displayData(inTime.toISOString(), outTime ? outTime.toISOString() : null, null, null);
                } else {
                    displayNoData();
                }
            } else {
                displayNoData();
            }
        } else {
            displayNoData();
        }
    });
}

// Parse Keka time format to Date object
function parseKekaTime(timeStr) {
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

// Display data from IN/OUT array
function displayDataFromArray(inOutArray) {
    if (!inOutArray || inOutArray.length === 0) {
        displayNoData();
        return;
    }

    const validSwipes = inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');

    if (validSwipes.length === 0) {
        displayNoData();
        return;
    }

    let firstIn = null;
    let lastOut = null;
    let totalEffectiveSeconds = 0;
    let totalBreakSeconds = 0;

    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseKekaTime(swipe.time);

        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (!firstIn) firstIn = swipeTime;

            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseKekaTime(validSwipes[i + 1].time);
                if (outTime) {
                    totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                    lastOut = outTime;

                    if (i + 2 < validSwipes.length && validSwipes[i + 2].type === 'IN') {
                        const nextInTime = parseKekaTime(validSwipes[i + 2].time);
                        if (nextInTime) {
                            totalBreakSeconds += (nextInTime - outTime) / 1000;
                        }
                    }
                }
            }
        }
    }

    const lastSwipe = validSwipes[validSwipes.length - 1];
    if (lastSwipe.type === 'IN') {
        const lastInTime = parseKekaTime(lastSwipe.time);
        if (lastInTime) {
            const now = new Date();
            totalEffectiveSeconds += (now - lastInTime) / 1000;
        }
    }

    displayData(
        firstIn ? firstIn.toISOString() : null,
        lastOut ? lastOut.toISOString() : null,
        totalEffectiveSeconds,
        totalBreakSeconds
    );
}

// Display data
function displayData(inTime, outTime, effectiveSeconds, breakSeconds) {
    if (!inTime) {
        displayNoData();
        return;
    }

    const inDate = new Date(inTime);
    const outDate = outTime ? new Date(outTime) : null;

    document.getElementById('inTime').textContent = formatTime(inDate);

    // Show early entry badge if entered before 10 AM
    const tenAMCheck = new Date(inDate);
    tenAMCheck.setHours(10, 0, 0, 0);
    const isEarlyEntryCheck = inDate < tenAMCheck;

    const earlyBadge = document.getElementById('earlyEntryBadge');
    if (earlyBadge) {
        earlyBadge.style.display = isEarlyEntryCheck ? 'block' : 'none';
    }

    let displayEffectiveSeconds = effectiveSeconds;
    if (displayEffectiveSeconds === null || displayEffectiveSeconds === undefined) {
        if (outDate) {
            displayEffectiveSeconds = (outDate - inDate) / 1000;
        } else {
            const now = new Date();
            displayEffectiveSeconds = (now - inDate) / 1000;
        }
    }

    const effectiveHours = Math.floor(displayEffectiveSeconds / 3600);
    const effectiveMinutes = Math.floor((displayEffectiveSeconds % 3600) / 60);
    document.getElementById('effectiveHours').textContent = `${effectiveHours}h ${effectiveMinutes}m`;

    const displayBreakSeconds = breakSeconds || 0;
    const breakHours = Math.floor(displayBreakSeconds / 3600);
    const breakMinutes = Math.floor((displayBreakSeconds % 3600) / 60);
    document.getElementById('breakTime').textContent = `${breakHours}h ${breakMinutes}m`;

    let displayGrossSeconds;
    if (outDate) {
        displayGrossSeconds = (outDate - inDate) / 1000;
    } else {
        const now = new Date();
        displayGrossSeconds = (now - inDate) / 1000;
    }

    const grossHours = Math.floor(displayGrossSeconds / 3600);
    const grossMinutes = Math.floor((displayGrossSeconds % 3600) / 60);
    document.getElementById('grossHours').textContent = `${grossHours}h ${grossMinutes}m`;

    const nineHoursInSeconds = 9 * 60 * 60;
    const isNineHoursComplete = displayEffectiveSeconds >= nineHoursInSeconds;

    // Check if entry was before 10 AM
    const tenAMDisplay = new Date(inDate);
    tenAMDisplay.setHours(10, 0, 0, 0);
    const isEarlyEntryDisplay = inDate < tenAMDisplay;

    if (outDate) {
        document.getElementById('outTime').textContent = formatTime(outDate);

        if (isNineHoursComplete) {
            document.getElementById('statusText').textContent = t('status_accomplished');
            document.getElementById('statusIndicator').className = 'status-indicator ok';
        } else {
            document.getElementById('statusText').textContent = t('status_grinding');
            document.getElementById('statusIndicator').className = 'status-indicator pending';
        }
    } else {
        document.getElementById('outTime').textContent = 'Still Working...';
        document.getElementById('statusText').textContent = t('status_ticking');
        document.getElementById('statusIndicator').className = 'status-indicator pending';
    }

    const effectiveEnd = new Date(inDate.getTime() + 8 * 60 * 60 * 1000);

    // Calculate target exit time based on entry time and 7 PM rule
    let targetExitTime;
    if (isEarlyEntryDisplay) {
        // If entered before 10 AM, target exit is 7 PM
        targetExitTime = new Date(inDate);
        targetExitTime.setHours(19, 0, 0, 0); // 7 PM
    } else {
        // If entered after 10 AM, use 9-hour rule
        targetExitTime = new Date(inDate.getTime() + 9 * 60 * 60 * 1000);
    }

    // Only set if element exists (it's commented out in HTML)
    const effectiveEndEl = document.getElementById('effectiveEnd');
    if (effectiveEndEl) {
        effectiveEndEl.textContent = formatTime(effectiveEnd, false);
    }

    const exitTimeEl = document.getElementById('exitTime');
    if (exitTimeEl) {
        exitTimeEl.textContent = formatTime(targetExitTime, false);
    }

    // Update target exit label based on entry time
    const targetExitLabel = document.getElementById('targetExitLabel');
    if (targetExitLabel && isEarlyEntryDisplay) {
        targetExitLabel.textContent = '🎯 Freedom Time (7 PM)';
    } else if (targetExitLabel) {
        targetExitLabel.textContent = '🎯 Target Exit';
    }

    updateRemainingTime(targetExitTime, outDate, isNineHoursComplete, isEarlyEntryDisplay);

    if (!isNineHoursComplete) {
        setupDefaultNotifications(inDate, targetExitTime);
    }
}

// Display no data state
function displayNoData() {
    document.getElementById('inTime').textContent = '--:--:--';
    document.getElementById('outTime').textContent = '--:--:--';
    document.getElementById('grossHours').textContent = '--h --m';
    document.getElementById('effectiveHours').textContent = '--h --m';
    document.getElementById('breakTime').textContent = '--h --m';
    document.getElementById('exitTime').textContent = '--:--:--';
    document.getElementById('remainingTime').textContent = '--:--:--';
    document.getElementById('statusText').textContent = t('status_no_data');

    const statusBanner = document.getElementById('statusBanner');
    const statusIcon = document.getElementById('statusIcon');
    if (statusBanner) statusBanner.className = 'status-banner inactive';
    if (statusIcon) statusIcon.textContent = '💤';

    document.getElementById('inoutListSection').style.display = 'none';

    // Hide progress bar
    const progressBar = document.getElementById('progressBar');
    if (progressBar) progressBar.style.width = '0%';
}

// Display IN/OUT list
function displayInOutList(inOutArray) {
    const listContainer = document.getElementById('inoutList');
    const sectionContainer = document.getElementById('inoutListSection');

    if (!inOutArray || inOutArray.length === 0) {
        sectionContainer.style.display = 'none';
        return;
    }

    if (!sectionContainer || !listContainer) {
        console.error('ERROR: Section or list container not found!');
        return;
    }

    // Force show the section
    sectionContainer.style.display = 'block';
    sectionContainer.style.visibility = 'visible';
    sectionContainer.removeAttribute('style');
    sectionContainer.style.display = 'block';

    listContainer.innerHTML = '';

    // Process swipes in pairs (IN/OUT)
    for (let i = 0; i < inOutArray.length; i++) {
        const swipe = inOutArray[i];

        // Only process IN swipes (we'll handle OUT in the same row)
        if (swipe.type === 'IN') {
            const item = document.createElement('div');
            item.className = 'inout-item-pair';

            // Left side - IN
            const inSide = document.createElement('div');
            inSide.className = 'inout-side in-side';

            const inLabel = document.createElement('span');
            inLabel.className = 'inout-label in-label';
            inLabel.textContent = '🟢 IN';

            const inTime = document.createElement('span');
            inTime.className = 'inout-time';
            inTime.textContent = swipe.time && swipe.time !== 'MISSING' ? swipe.time : 'MISSING';

            inSide.appendChild(inLabel);
            inSide.appendChild(inTime);

            // Right side - OUT
            const outSide = document.createElement('div');
            outSide.className = 'inout-side out-side';

            const outLabel = document.createElement('span');
            outLabel.className = 'inout-label out-label';
            outLabel.textContent = '🔴 OUT';

            const outTime = document.createElement('span');
            outTime.className = 'inout-time';

            // Check if next swipe is OUT
            let durationSpan = null;
            if (i + 1 < inOutArray.length && inOutArray[i + 1].type === 'OUT') {
                const outSwipe = inOutArray[i + 1];
                outTime.textContent = outSwipe.time && outSwipe.time !== 'MISSING' ? outSwipe.time : 'MISSING';

                // Calculate duration if both times are valid
                if (swipe.time && swipe.time !== 'MISSING' && outSwipe.time && outSwipe.time !== 'MISSING') {
                    const inTimeObj = parseKekaTime(swipe.time);
                    const outTimeObj = parseKekaTime(outSwipe.time);
                    if (inTimeObj && outTimeObj) {
                        const durationSeconds = (outTimeObj - inTimeObj) / 1000;
                        const hours = Math.floor(durationSeconds / 3600);
                        const minutes = Math.floor((durationSeconds % 3600) / 60);

                        // durationSpan = document.createElement('span');
                        // durationSpan.className = 'inout-duration';
                        // durationSpan.textContent = `(${hours}h ${minutes}m)`;
                    }
                }
                i++; // Skip the next OUT since we've already processed it
            } else {
                outTime.textContent = 'MISSING';
                outTime.classList.add('missing-data');
            }

            outSide.appendChild(outLabel);
            outSide.appendChild(outTime);
            if (durationSpan) {
                outSide.appendChild(durationSpan);
            }

            item.appendChild(inSide);
            item.appendChild(outSide);
            listContainer.appendChild(item);
        }
    }
}

// Initialize Punch Card Toggle
function initPunchCardToggle() {
    const header = document.getElementById('punchCardHeader');
    const section = document.getElementById('inoutListSection');

    if (header && section) {
        header.addEventListener('click', () => {
            section.classList.toggle('collapsed');

            // Save state
            const isCollapsed = section.classList.contains('collapsed');
            chrome.storage.local.set({ punchCardCollapsed: isCollapsed });
        });
    }

    // Load saved state
    chrome.storage.local.get(['punchCardCollapsed'], (data) => {
        if (data.punchCardCollapsed && section) {
            section.classList.add('collapsed');
        }
    });
}

// Setup default notifications
function setupDefaultNotifications(firstInTime, targetExitTime) {
    // Note: Effective 8h notification will be triggered when actual effective hours reach 8
    // We pass a placeholder time here, but the actual monitoring happens in background
    const effectivePlaceholder = new Date(firstInTime.getTime() + 8 * 60 * 60 * 1000);

    // Check if entry was before 10 AM for appropriate messaging
    const tenAM = new Date(firstInTime);
    tenAM.setHours(10, 0, 0, 0);
    const isEarlyEntry = firstInTime < tenAM;

    chrome.storage.local.get(['defaultNotifications'], (data) => {
        const defaultNotifs = data.defaultNotifications || {
            effective: { message: '🎉 8 Hours Complete (Effective)! Great work!' },
            gross: { message: isEarlyEntry ? '🎯 7 PM Freedom Time! You can leave now! 🚀' : '🎯 Target Exit Time! You can leave now.' }
        };

        // Reset the notification sent flags for today
        chrome.storage.local.set({
            effective8hNotificationSent: false,
            targetExitNotificationSent: false
        });

        chrome.runtime.sendMessage({
            type: 'SETUP_DEFAULT_NOTIFICATIONS',
            effectiveTime: effectivePlaceholder.toISOString(),
            grossTime: targetExitTime.toISOString(),
            effectiveMessage: defaultNotifs.effective.message,
            grossMessage: defaultNotifs.gross.message,
            isEarlyEntry: isEarlyEntry
        });
    });
}

// Update remaining time
function updateRemainingTime(exitTime, outDate, isComplete, isEarlyEntry) {
    const now = new Date();

    if (outDate && isComplete) {
        document.getElementById('remainingTime').textContent = t('countdown_done');
        document.getElementById('countdownSubtitle').textContent = 'Great job today! 🎉';
        return;
    }

    const remaining = exitTime - now;

    if (remaining <= 0) {
        if (isEarlyEntry) {
            document.getElementById('remainingTime').textContent = '🎉 Freedom Time!';
            document.getElementById('countdownSubtitle').textContent = 'You can leave now! Enjoy your evening! 🌅';
        } else {
            document.getElementById('remainingTime').textContent = t('countdown_overtime');
            document.getElementById('countdownSubtitle').textContent = 'You\'ve put in the hours! 💪';
        }
        return;
    }

    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

    const timeString = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    document.getElementById('remainingTime').textContent = timeString;

    // Update subtitle based on entry type
    const subtitleEl = document.getElementById('countdownSubtitle');
    if (isEarlyEntry) {
        if (hours <= 1) {
            subtitleEl.textContent = 'Almost 7 PM! Freedom is near! 🎯';
        } else {
            subtitleEl.textContent = 'Countdown to 7 PM freedom! 🚀';
        }
    } else {
        if (hours <= 1) {
            subtitleEl.textContent = 'Almost there! You can do it! 💪';
        } else {
            subtitleEl.textContent = 'Time until you can escape! 🚀';
        }
    }
}

// Start countdown timer
function startCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    countdownInterval = setInterval(() => {
        chrome.storage.local.get(['scrapedAttendance'], (data) => {
            if (!data.scrapedAttendance) return;

            const todayEntry = findTodayEntry(data.scrapedAttendance.entries);
            if (!todayEntry || !todayEntry.inOutArray) return;

            const validSwipes = todayEntry.inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');
            if (validSwipes.length === 0) return;

            let firstInTime = null;
            let lastOutTime = null;
            let totalEffectiveSeconds = 0;
            let totalBreakSeconds = 0;
            let isCurrentlyWorking = false;

            for (let i = 0; i < validSwipes.length; i++) {
                const swipe = validSwipes[i];
                const swipeTime = parseKekaTime(swipe.time);

                if (!swipeTime) continue;

                if (swipe.type === 'IN') {
                    if (!firstInTime) firstInTime = swipeTime;

                    if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                        const outTime = parseKekaTime(validSwipes[i + 1].time);
                        if (outTime) {
                            totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                            lastOutTime = outTime;

                            if (i + 2 < validSwipes.length && validSwipes[i + 2].type === 'IN') {
                                const nextInTime = parseKekaTime(validSwipes[i + 2].time);
                                if (nextInTime) {
                                    totalBreakSeconds += (nextInTime - outTime) / 1000;
                                }
                            }
                        }
                    }
                }
            }

            const lastSwipe = validSwipes[validSwipes.length - 1];
            if (lastSwipe && lastSwipe.type === 'IN') {
                const lastInTime = parseKekaTime(lastSwipe.time);
                if (lastInTime) {
                    const now = new Date();
                    totalEffectiveSeconds += (now - lastInTime) / 1000;
                    isCurrentlyWorking = true;
                }
            }

            if (firstInTime) {
                // Check if entry was before 10 AM
                const tenAM = new Date(firstInTime);
                tenAM.setHours(10, 0, 0, 0);
                const isEarlyEntry = firstInTime < tenAM;

                // Calculate target exit time based on entry time
                let exitTime;
                if (isEarlyEntry) {
                    // If entered before 10 AM, target exit is 7 PM
                    exitTime = new Date(firstInTime);
                    exitTime.setHours(19, 0, 0, 0); // 7 PM
                } else {
                    // If entered after 10 AM, use 9-hour rule
                    exitTime = new Date(firstInTime.getTime() + 9 * 60 * 60 * 1000);
                }

                const now = new Date();

                // Update UI elements for early entry
                const targetExitLabel = document.getElementById('targetExitLabel');
                if (targetExitLabel && isEarlyEntry) {
                    targetExitLabel.textContent = '🎯 Freedom Time (7 PM)';
                } else if (targetExitLabel) {
                    targetExitLabel.textContent = '🎯 Target Exit';
                }

                const earlyBadge = document.getElementById('earlyEntryBadge');
                if (earlyBadge) {
                    earlyBadge.style.display = isEarlyEntry ? 'block' : 'none';
                }

                let currentGrossSeconds;
                if (isCurrentlyWorking || !lastOutTime) {
                    currentGrossSeconds = (now - firstInTime) / 1000;
                } else {
                    currentGrossSeconds = (lastOutTime - firstInTime) / 1000;
                }

                const grossHours = Math.floor(currentGrossSeconds / 3600);
                const grossMinutes = Math.floor((currentGrossSeconds % 3600) / 60);
                document.getElementById('grossHours').textContent = `${grossHours}h ${grossMinutes}m`;

                const effectiveHours = Math.floor(totalEffectiveSeconds / 3600);
                const effectiveMinutes = Math.floor((totalEffectiveSeconds % 3600) / 60);
                document.getElementById('effectiveHours').textContent = `${effectiveHours}h ${effectiveMinutes}m`;

                const breakHours = Math.floor(totalBreakSeconds / 3600);
                const breakMinutes = Math.floor((totalBreakSeconds % 3600) / 60);
                document.getElementById('breakTime').textContent = `${breakHours}h ${breakMinutes}m`;

                const nineHoursInSeconds = 9 * 60 * 60;
                const isComplete = totalEffectiveSeconds >= nineHoursInSeconds;

                updateRemainingTime(exitTime, lastOutTime, isComplete, isEarlyEntry);

                if (lastOutTime && isComplete) {
                    document.getElementById('statusText').textContent = t('status_accomplished');
                    document.getElementById('statusIndicator').className = 'status-indicator ok';
                } else if (lastOutTime && !isComplete) {
                    document.getElementById('statusText').textContent = t('status_grinding');
                    document.getElementById('statusIndicator').className = 'status-indicator pending';
                }
            }
        });
    }, 1000);
}

// Format time
function formatTime(date, includeSeconds = true) {
    let hours = date.getHours();
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const ampm = hours >= 12 ? 'PM' : 'AM';

    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = pad(hours);

    if (includeSeconds) {
        return `${hoursStr}:${minutes}:${seconds} ${ampm}`;
    } else {
        return `${hoursStr}:${minutes} ${ampm}`;
    }
}

// Pad number
function pad(num) {
    return num.toString().padStart(2, '0');
}

// Token & UI Management
function checkTokenAndUpdateUI() {
    chrome.storage.local.get(['kekaAuthToken'], (data) => {
        const hasToken = data.kekaAuthToken && data.kekaAuthToken.trim().length > 0;
        const kekaBtn = document.getElementById('openKeka');

        if (hasToken) {
            kekaBtn.style.display = 'none';

            // Always fetch data when extension opens with valid token
            autoFetchData();
        } else {
            kekaBtn.style.display = 'block';
        }
    });
}

function autoFetchWorkspaceData() {
    chrome.storage.local.get(['autoSyncEnabled'], (data) => {
        if (data.autoSyncEnabled === false) {
            return;
        }

        chrome.runtime.sendMessage({ type: 'FETCH_WORKSPACE_DATA' }, () => {
            const workspacePage = document.getElementById('workspacePage');
            if (workspacePage?.classList.contains('active') && typeof fetchAndRenderTimesheet === 'function') {
                fetchAndRenderTimesheet();
            }
        });
    });
}

function autoFetchData() {
    // Check if auto-sync is enabled
    chrome.storage.local.get(['autoSyncEnabled'], (data) => {
        if (data.autoSyncEnabled === false) {
            return;
        }

        // Show syncing animation
        const syncCard = document.querySelector('.sync-card');
        const syncIcon = document.querySelector('.sync-icon');
        const statusDiv = document.getElementById('scrapeStatus');

        if (syncCard) syncCard.classList.add('syncing');
        if (statusDiv) {
            statusDiv.className = 'scrape-status info';
            statusDiv.textContent = t('sync_syncing');
        }

        chrome.runtime.sendMessage({ type: 'FETCH_ATTENDANCE_API' }, (response) => {
            // Remove syncing animation
            if (syncCard) syncCard.classList.remove('syncing');

            if (response && response.success) {
                loadData();

                if (statusDiv) {
                    statusDiv.className = 'scrape-status success';
                    statusDiv.textContent = `${t('sync_success')} ${new Date().toLocaleTimeString()}`;

                    // Hide success message after 3 seconds
                    setTimeout(() => {
                        statusDiv.className = 'scrape-status';
                        statusDiv.style.display = 'none';
                    }, 3000);
                }
            } else {
                if (statusDiv) {
                    statusDiv.className = 'scrape-status error';
                    statusDiv.textContent = response?.error || t('sync_error');
                }
            }
        });
    });
}

function openKekaWebsite() {
    const statusDiv = document.getElementById('scrapeStatus');
    if (statusDiv) {
        statusDiv.className = 'scrape-status info';
        statusDiv.textContent = '🔑 Opening Keka... Your magic key will be captured automatically!';
    }

    chrome.tabs.create({
        url: 'https://acquaint.keka.com/#/me/attendance/logs',
        active: true
    });
}

// Settings Page
function loadSettingsPage() {
    chrome.storage.local.get(['kekaAuthToken', 'tokenExtractedAt', 'darkMode', 'notificationsEnabled', 'autoSyncEnabled'], (data) => {
        const badge = document.getElementById('tokenBadge');
        const statusText = document.getElementById('tokenStatusText');
        const details = document.getElementById('tokenDetails');

        if (data.kekaAuthToken && data.kekaAuthToken.trim().length > 0) {
            badge.textContent = t('token_connected');
            badge.className = 'card-badge connected';
            statusText.textContent = t('token_status_ok');

            if (data.tokenExtractedAt) {
                const date = new Date(data.tokenExtractedAt);
                details.textContent = `Last synced: ${date.toLocaleString()}`;
            } else {
                details.textContent = 'Token is active and ready!';
            }
        } else {
            badge.textContent = t('token_disconnected');
            badge.className = 'card-badge disconnected';
            statusText.textContent = t('token_status_none');
            details.textContent = '';
        }
    });

    renderNotifications();
    loadShiftData();
    loadPreferences();
}

// Initialize Settings Tabs
function initSettingsTabs() {
    const tabButtons = document.querySelectorAll('.settings-tab');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;
            switchSettingsTab(targetTab);
        });
    });
}

function switchSettingsTab(tabName) {
    // Remove active from all tabs
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    // Hide all tab contents
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
    });

    // Activate selected tab
    const targetBtn = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    if (targetBtn) {
        targetBtn.classList.add('active');
    }

    // Show selected content
    const targetContent = tabName === 'control-center' ?
        document.getElementById('controlCenterTab') :
        document.getElementById('generalTab');

    if (targetContent) {
        targetContent.classList.add('active');
    }

    // Load shift data when switching to general tab
    if (tabName === 'general') {
        loadShiftData();
    }
}

// Load Shift Data from API
function loadShiftData() {
    const loadingState = document.getElementById('shiftDataLoading');
    const contentState = document.getElementById('shiftDataContent');
    const errorState = document.getElementById('shiftDataError');

    // Show loading
    loadingState.style.display = 'block';
    contentState.style.display = 'none';
    errorState.style.display = 'none';

    chrome.storage.local.get(['scrapedAttendance'], (data) => {
        if (!data.scrapedAttendance || !data.scrapedAttendance.entries || data.scrapedAttendance.entries.length === 0) {
            // No data, show error
            loadingState.style.display = 'none';
            errorState.style.display = 'block';
            return;
        }

        // Get today's entry (first entry should be most recent)
        const todayEntry = findTodayEntry(data.scrapedAttendance.entries);

        if (todayEntry) {
            // Display shift information
            document.getElementById('shiftName').textContent = todayEntry.shift || 'Not Available';
            document.getElementById('shiftStart').textContent = todayEntry.shiftStart || '--:--';
            document.getElementById('shiftEnd').textContent = todayEntry.shiftEnd || '--:--';

            // Calculate shift duration
            if (todayEntry.shiftStart && todayEntry.shiftEnd) {
                const duration = calculateShiftDuration(todayEntry.shiftStart, todayEntry.shiftEnd);
                document.getElementById('shiftDuration').textContent = duration;
            } else {
                document.getElementById('shiftDuration').textContent = '--h --m';
            }

            // Show content
            loadingState.style.display = 'none';
            contentState.style.display = 'block';
        } else {
            // No today entry found
            loadingState.style.display = 'none';
            errorState.style.display = 'block';
        }
    });
}

// Calculate shift duration
function calculateShiftDuration(startTime, endTime) {
    try {
        const start = parseTime12Hour(startTime);
        const end = parseTime12Hour(endTime);

        if (!start || !end) return '--h --m';

        let diff = end - start;
        if (diff < 0) diff += 24 * 60 * 60 * 1000; // Handle overnight shifts

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        return `${hours}h ${minutes}m`;
    } catch (e) {
        return '--h --m';
    }
}

// Parse 12-hour time format
function parseTime12Hour(timeStr) {
    try {
        const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!match) return null;

        let hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const period = match[3].toUpperCase();

        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;

        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        return date;
    } catch (e) {
        return null;
    }
}

// Load Preferences
function loadPreferences() {
    chrome.storage.local.get(['darkMode', 'notificationsEnabled', 'autoSyncEnabled', 'language', 'funnyTextMode'], (data) => {
        document.getElementById('darkModeToggle').checked = data.darkMode || false;
        document.getElementById('notificationsToggle').checked = data.notificationsEnabled !== false;
        document.getElementById('autoSyncToggle').checked = data.autoSyncEnabled !== false;
        document.getElementById('languageSelect').value = data.language || 'en';
        const funnyToggle = document.getElementById('funnyTextToggle');
        if (funnyToggle) {
            funnyToggle.checked = data.funnyTextMode !== false;
        }
    });
}

// Handle Dark Mode Toggle
function handleDarkModeToggle(e) {
    const isDark = e.target.checked;
    if (isDark) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    setThemeIcon(isDark);
    chrome.storage.local.set({ darkMode: isDark });
}

// Handle Notifications Toggle
function handleNotificationsToggle(e) {
    const enabled = e.target.checked;
    chrome.storage.local.set({ notificationsEnabled: enabled });
}

// Handle Auto-Sync Toggle
function handleAutoSyncToggle(e) {
    const enabled = e.target.checked;
    chrome.storage.local.set({ autoSyncEnabled: enabled });
}

// Handle Language Change
function handleLanguageChange(e) {
    const lang = e.target.value;
    setLanguage(lang);
    const workspacePage = document.getElementById('workspacePage');
    if (workspacePage?.classList.contains('active') && typeof loadWorkspaceData === 'function') {
        loadWorkspaceData();
    }
}

function handleFunnyTextToggle(e) {
    setFunnyTextMode(e.target.checked);
    const workspacePage = document.getElementById('workspacePage');
    if (workspacePage?.classList.contains('active') && typeof loadWorkspaceData === 'function') {
        loadWorkspaceData();
    }
}

function loadNotifications() {
    chrome.storage.local.get(['notifications', 'defaultNotifications'], (data) => {
        notifications = data.notifications || [];
    });
}

function renderNotifications() {
    const container = document.getElementById('notificationsList');
    container.innerHTML = '';

    // Get default notifications from storage
    chrome.storage.local.get(['defaultNotifications'], (data) => {
        const defaultNotifs = data.defaultNotifications || {
            effective: { message: '🎉 8 Hours Complete (Effective)! Great work!' },
            gross: { message: '� TaHrget Exit Time! You can leave now.' }
        };

        // Render default notifications (non-removable)
        const defaultSection = document.createElement('div');
        defaultSection.className = 'default-notifications-section';
        defaultSection.innerHTML = `
            <div class="section-header">
                <h4 class="section-title">🔔 Default Notifications</h4>
                <span class="section-badge">Auto-managed</span>
            </div>
        `;

        // Effective Hours (8h) notification
        const effectiveItem = document.createElement('div');
        effectiveItem.className = 'notification-item default-notification';
        effectiveItem.innerHTML = `
            <div class="notification-item-header">
                <span class="notification-number">✅ 8 Hours Complete (Effective)</span>
                <span class="notification-time-badge">Auto-calculated</span>
            </div>
            <div class="notification-fields">
                <div class="field-group">
                    <label class="field-label">💬 Message</label>
                    <input type="text" class="field-input default-notif-input" data-type="effective" value="${defaultNotifs.effective.message}" placeholder="Enter notification message">
                </div>
                <div class="field-info">
                    <span class="info-icon">ℹ️</span>
                    <span class="info-text">Triggers when your actual effective working hours reach 8 hours (excluding breaks)</span>
                </div>
            </div>
        `;
        defaultSection.appendChild(effectiveItem);

        // Target Exit (9h gross) notification
        const grossItem = document.createElement('div');
        grossItem.className = 'notification-item default-notification';
        grossItem.innerHTML = `
            <div class="notification-item-header">
                <span class="notification-number">🎯 Target Exit (9h Gross)</span>
                <span class="notification-time-badge">Auto-calculated</span>
            </div>
            <div class="notification-fields">
                <div class="field-group">
                    <label class="field-label">💬 Message</label>
                    <input type="text" class="field-input default-notif-input" data-type="gross" value="${defaultNotifs.gross.message}" placeholder="Enter notification message">
                </div>
                <div class="field-info">
                    <span class="info-icon">ℹ️</span>
                    <span class="info-text">Triggers when BOTH conditions are met: 9 gross hours passed AND 8 effective hours completed</span>
                </div>
            </div>
        `;
        defaultSection.appendChild(grossItem);

        container.appendChild(defaultSection);

        // Add event listeners for default notification inputs
        container.querySelectorAll('.default-notif-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const type = e.target.dataset.type;
                defaultNotifs[type].message = e.target.value;
                chrome.storage.local.set({ defaultNotifications: defaultNotifs });
            });
        });

        // Render custom notifications
        if (notifications.length > 0) {
            const customSection = document.createElement('div');
            customSection.className = 'custom-notifications-section';
            customSection.innerHTML = `
                <div class="section-header">
                    <h4 class="section-title">⏰ Custom Reminders</h4>
                </div>
            `;

            notifications.forEach((notif, index) => {
                const item = document.createElement('div');
                item.className = 'notification-item';
                item.innerHTML = `
                    <div class="notification-item-header">
                        <span class="notification-number">⏰ Reminder #${index + 1}</span>
                        <button class="btn-remove" data-index="${index}">🗑️</button>
                    </div>
                    <div class="notification-fields">
                        <div class="field-group">
                            <label class="field-label">⏱️ When?</label>
                            <input type="time" class="field-input" data-index="${index}" data-field="time" value="${notif.time || ''}">
                        </div>
                        <div class="field-group">
                            <label class="field-label">💬 What to say?</label>
                            <input type="text" class="field-input" data-index="${index}" data-field="description" value="${notif.description || ''}" placeholder="e.g., Time for coffee break! ☕">
                        </div>
                    </div>
                `;
                customSection.appendChild(item);
            });

            container.appendChild(customSection);

            // Add event listeners for custom notifications
            container.querySelectorAll('.btn-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    removeNotification(index);
                });
            });

            container.querySelectorAll('.field-input').forEach(input => {
                input.addEventListener('input', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    const field = e.target.dataset.field;
                    notifications[index][field] = e.target.value;
                });
            });
        }
    });
}

function addNotification() {
    notifications.push({
        time: '',
        description: ''
    });
    renderNotifications();
}

function removeNotification(index) {
    notifications.splice(index, 1);
    renderNotifications();
}

function saveSettings() {
    const validNotifications = notifications.filter(n => n.time && n.description);

    if (validNotifications.length !== notifications.length) {
        alert('⚠️ Please fill in all reminder fields or remove empty ones!');
        return;
    }

    // Get default notifications
    chrome.storage.local.get(['defaultNotifications'], (data) => {
        const defaultNotifs = data.defaultNotifications || {
            effective: { message: '🎉 8 Hours Complete (Effective)! Great work!' },
            gross: { message: '� Targert Exit Time! You can leave now.' }
        };

        chrome.storage.local.set({ notifications: validNotifications }, () => {
            chrome.runtime.sendMessage({
                type: 'UPDATE_NOTIFICATIONS',
                notifications: validNotifications,
                defaultNotifications: defaultNotifs
            }, (response) => {
                if (response && response.success) {
                    alert('✅ Settings saved! Your reminders are all set.');
                } else {
                    alert('⚠️ Settings saved but there was an issue setting up reminders.');
                }
            });
        });
    });
}

function testNotification() {
    chrome.runtime.sendMessage({
        type: 'TEST_NOTIFICATION'
    }, (response) => {
        if (response && response.success) {
            // Modal shows on the active Keka/Workspace tab
        }
    });
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.scrapedAttendance) {
            loadData();
        }

        if (changes.kekaAuthToken) {
            checkTokenAndUpdateUI();
        }
    }
});
