// Popup script - Redesigned

let countdownInterval = null;

// chrome.storage.local.set({
//     notifications: [{
//         "time": "13:00",
//         "description": "Time for lunch! Take 60 minutes to recharge. 🥪"
//     },
//     {
//         "time": "17:00",
//         "description": "Time for a short break! ☕"
//     }]
// })
let notifications = [];

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    loadNotifications();
    checkTokenAndUpdateUI();
    loadData();
    startCountdown();

    // Event listeners
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('scrapeManual').addEventListener('click', scrapeManual);
    document.getElementById('openKeka').addEventListener('click', openKekaWebsite);
    document.getElementById('addNotification').addEventListener('click', addNotification);
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    document.getElementById('testNotification').addEventListener('click', testNotification);

    // Modal close on outside click
    window.addEventListener('click', (e) => {
        const modal = document.getElementById('settingsModal');
        if (e.target === modal) {
            closeSettings();
        }
    });
});

// Load theme preference
function loadTheme() {
    chrome.storage.local.get(['darkMode'], (result) => {
        if (result.darkMode) {
            document.body.classList.add('dark-mode');
            document.getElementById('themeToggle').textContent = '☀️';
        }
    });
}

// Toggle theme
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    document.getElementById('themeToggle').textContent = isDark ? '☀️' : '🌙';
    chrome.storage.local.set({ darkMode: isDark });
}

// Load data from storage
function loadData() {
    chrome.storage.local.get(['scrapedAttendance'], (data) => {
        if (!data.scrapedAttendance) {
            displayNoData();
            return;
        }

        // Use scraped data
        const todayEntry = findTodayEntry(data.scrapedAttendance.entries);

        if (todayEntry) {
            // Use inOutArray if available, otherwise fall back to checkIn/checkOut
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

    // Filter out any entries with "MISSING" time before processing
    const validSwipes = inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');

    if (validSwipes.length === 0) {
        displayNoData();
        return;
    }

    // Find first IN and last OUT
    let firstIn = null;
    let lastOut = null;
    let totalEffectiveSeconds = 0;
    let totalBreakSeconds = 0;

    // Calculate effective hours and break time from all IN/OUT pairs
    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseKekaTime(swipe.time);

        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (!firstIn) firstIn = swipeTime;

            // Look for matching OUT
            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseKekaTime(validSwipes[i + 1].time);
                if (outTime) {
                    totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                    lastOut = outTime;

                    // Calculate break time (time between OUT and next IN)
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

    // If last swipe is IN without OUT, calculate till now
    const lastSwipe = validSwipes[validSwipes.length - 1];
    if (lastSwipe.type === 'IN') {
        const lastInTime = parseKekaTime(lastSwipe.time);
        if (lastInTime) {
            const now = new Date();
            totalEffectiveSeconds += (now - lastInTime) / 1000;
            // Don't set lastOut, keep it null to show "Pending"
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

    // Display IN time
    document.getElementById('inTime').textContent = formatTime(inDate);

    // Calculate and display effective hours
    let displayEffectiveSeconds = effectiveSeconds;
    if (displayEffectiveSeconds === null || displayEffectiveSeconds === undefined) {
        // Fallback: simple calculation from first IN to last OUT
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

    // Calculate and display break time
    const displayBreakSeconds = breakSeconds || 0;
    const breakHours = Math.floor(displayBreakSeconds / 3600);
    const breakMinutes = Math.floor((displayBreakSeconds % 3600) / 60);
    document.getElementById('breakTime').textContent = `${breakHours}h ${breakMinutes}m`;

    // Calculate and display gross hours (from first IN to last OUT or now)
    let displayGrossSeconds;
    if (outDate) {
        // Finished: gross = first IN to last OUT
        displayGrossSeconds = (outDate - inDate) / 1000;
    } else {
        // Still working: gross = first IN to now
        const now = new Date();
        displayGrossSeconds = (now - inDate) / 1000;
    }

    const grossHours = Math.floor(displayGrossSeconds / 3600);
    const grossMinutes = Math.floor((displayGrossSeconds % 3600) / 60);
    document.getElementById('grossHours').textContent = `${grossHours}h ${grossMinutes}m`;

    // Check if 9 hours (effective) are completed
    const nineHoursInSeconds = 9 * 60 * 60;
    const isNineHoursComplete = displayEffectiveSeconds >= nineHoursInSeconds;

    // Display OUT time and status
    if (outDate) {
        document.getElementById('outTime').textContent = formatTime(outDate);

        // Only show completed if 9 hours are done
        if (isNineHoursComplete) {
            document.getElementById('statusText').textContent = '✅ Completed (9h)';
            document.getElementById('statusIndicator').className = 'status-indicator ok';
        } else {
            document.getElementById('statusText').textContent = '⏳ Working (< 9h)';
            document.getElementById('statusIndicator').className = 'status-indicator pending';
        }
    } else {
        document.getElementById('outTime').textContent = 'Pending';
        document.getElementById('statusText').textContent = '⏳ OUT Pending';
        document.getElementById('statusIndicator').className = 'status-indicator pending';
    }

    // Calculate times based on first IN
    const effectiveEnd = new Date(inDate.getTime() + 8 * 60 * 60 * 1000);
    const exitTime = new Date(inDate.getTime() + 9 * 60 * 60 * 1000);

    document.getElementById('effectiveEnd').textContent = formatTime(effectiveEnd, false);
    document.getElementById('exitTime').textContent = formatTime(exitTime, false);

    // Calculate remaining time - only show completed if 9 hours done
    updateRemainingTime(exitTime, outDate, isNineHoursComplete);

    // Set up default notifications for 8h and 9h completion (only if not complete)
    if (!isNineHoursComplete) {
        setupDefaultNotifications(inDate);
    }
}

// Display no data state
function displayNoData() {
    document.getElementById('inTime').textContent = '--:--:--';
    document.getElementById('outTime').textContent = '--:--:--';
    document.getElementById('grossHours').textContent = '--h --m';
    document.getElementById('effectiveHours').textContent = '--h --m';
    document.getElementById('breakTime').textContent = '--h --m';
    document.getElementById('effectiveEnd').textContent = '--:--:--';
    document.getElementById('exitTime').textContent = '--:--:--';
    document.getElementById('remainingTime').textContent = '--:--:--';
    document.getElementById('statusText').textContent = 'No data available. Please scrape from Keka.';
    document.getElementById('statusIndicator').className = 'status-indicator inactive';
    document.getElementById('inoutListSection').style.display = 'none';
}

// Display IN/OUT list
function displayInOutList(inOutArray) {
    const listContainer = document.getElementById('inoutList');
    const sectionContainer = document.getElementById('inoutListSection');

    if (!inOutArray || inOutArray.length === 0) {
        sectionContainer.style.display = 'none';
        return;
    }

    // Filter out any entries with "MISSING" time
    const validSwipes = inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');

    if (validSwipes.length === 0) {
        sectionContainer.style.display = 'none';
        return;
    }

    sectionContainer.style.display = 'block';
    listContainer.innerHTML = '';

    validSwipes.forEach((swipe, index) => {
        const item = document.createElement('div');
        item.className = `inout-item ${swipe.type.toLowerCase()}-type`;

        const typeSpan = document.createElement('span');
        typeSpan.className = `inout-item-type ${swipe.type.toLowerCase()}`;
        typeSpan.textContent = swipe.type === 'IN' ? '🟢 IN' : '🔴 OUT';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'inout-item-time';
        timeSpan.textContent = swipe.time;

        // Calculate duration if this is an OUT with previous IN
        let durationSpan = null;
        if (swipe.type === 'OUT' && index > 0 && validSwipes[index - 1].type === 'IN') {
            const inTime = parseKekaTime(validSwipes[index - 1].time);
            const outTime = parseKekaTime(swipe.time);
            if (inTime && outTime) {
                const durationSeconds = (outTime - inTime) / 1000;
                const hours = Math.floor(durationSeconds / 3600);
                const minutes = Math.floor((durationSeconds % 3600) / 60);

                durationSpan = document.createElement('span');
                durationSpan.className = 'inout-item-duration';
                durationSpan.textContent = `(${hours}h ${minutes}m)`;
            }
        }

        item.appendChild(typeSpan);
        item.appendChild(timeSpan);
        if (durationSpan) {
            item.appendChild(durationSpan);
        }

        listContainer.appendChild(item);
    });
}

// Setup default notifications for 8h and 9h completion
function setupDefaultNotifications(firstInTime) {
    const effectiveTime = new Date(firstInTime.getTime() + 8 * 60 * 60 * 1000); // 8 hours
    const grossTime = new Date(firstInTime.getTime() + 9 * 60 * 60 * 1000); // 9 hours

    // Send to background to set up alarms
    chrome.runtime.sendMessage({
        type: 'SETUP_DEFAULT_NOTIFICATIONS',
        effectiveTime: effectiveTime.toISOString(),
        grossTime: grossTime.toISOString()
    });
}

// Update remaining time and hours
function updateRemainingTime(exitTime, outDate, isComplete) {
    const now = new Date();

    // Only show completed if 9 hours are actually done
    if (outDate && isComplete) {
        document.getElementById('remainingTime').textContent = 'Completed';
        // Hours already set, don't update
        return;
    }

    const remaining = exitTime - now;

    if (remaining <= 0) {
        document.getElementById('remainingTime').textContent = 'Time exceeded';
        return;
    }

    // Calculate remaining time
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

    const timeString = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    document.getElementById('remainingTime').textContent = timeString;
}

// Start countdown timer
function startCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    countdownInterval = setInterval(() => {
        chrome.storage.local.get(['scrapedAttendance', 'manualOverride'], (data) => {
            let firstInTime = null;
            let lastOutTime = null;
            let effectiveSeconds = 0;
            let breakSeconds = 0;
            let isCurrentlyWorking = false;

            if (data.manualOverride) {
                firstInTime = new Date(data.manualOverride.inTime);
                lastOutTime = data.manualOverride.outTime ? new Date(data.manualOverride.outTime) : null;
            } else if (data.scrapedAttendance) {
                const todayEntry = findTodayEntry(data.scrapedAttendance.entries);
                if (todayEntry) {
                    // Calculate from inOutArray if available
                    if (todayEntry.inOutArray && todayEntry.inOutArray.length > 0) {
                        // Filter out MISSING entries
                        const validSwipes = todayEntry.inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');

                        let totalEffectiveSeconds = 0;
                        let totalBreakSeconds = 0;

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

                                        // Calculate break time
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

                        // If last swipe is IN without OUT, add time till now
                        const lastSwipe = validSwipes[validSwipes.length - 1];
                        if (lastSwipe && lastSwipe.type === 'IN') {
                            const lastInTime = parseKekaTime(lastSwipe.time);
                            if (lastInTime) {
                                const now = new Date();
                                totalEffectiveSeconds += (now - lastInTime) / 1000;
                                isCurrentlyWorking = true;
                                // Don't set lastOutTime since we're still working
                            }
                        }

                        effectiveSeconds = totalEffectiveSeconds;
                        breakSeconds = totalBreakSeconds;
                    } else if (todayEntry.checkIn) {
                        firstInTime = parseKekaTime(todayEntry.checkIn);
                        lastOutTime = todayEntry.checkOut && todayEntry.checkOut !== 'MISSING' ? parseKekaTime(todayEntry.checkOut) : null;
                    }
                }
            }

            if (firstInTime) {
                const exitTime = new Date(firstInTime.getTime() + 9 * 60 * 60 * 1000);
                const now = new Date();

                // Calculate current effective seconds
                let currentEffectiveSeconds = effectiveSeconds;

                // If no array data, calculate simple effective time
                if (effectiveSeconds === 0) {
                    if (lastOutTime) {
                        currentEffectiveSeconds = (lastOutTime - firstInTime) / 1000;
                    } else {
                        currentEffectiveSeconds = (now - firstInTime) / 1000;
                    }
                }

                // Calculate gross hours (from first IN to last OUT or now if working)
                let currentGrossSeconds;
                if (isCurrentlyWorking || !lastOutTime) {
                    // Still working: gross = first IN to now
                    currentGrossSeconds = (now - firstInTime) / 1000;
                } else {
                    // Finished: gross = first IN to last OUT
                    currentGrossSeconds = (lastOutTime - firstInTime) / 1000;
                }

                // Update gross hours display
                const grossHours = Math.floor(currentGrossSeconds / 3600);
                const grossMinutes = Math.floor((currentGrossSeconds % 3600) / 60);
                document.getElementById('grossHours').textContent = `${grossHours}h ${grossMinutes}m`;

                // Update effective hours display
                const effectiveHours = Math.floor(currentEffectiveSeconds / 3600);
                const effectiveMinutes = Math.floor((currentEffectiveSeconds % 3600) / 60);
                document.getElementById('effectiveHours').textContent = `${effectiveHours}h ${effectiveMinutes}m`;

                // Update break time display
                const breakHours = Math.floor(breakSeconds / 3600);
                const breakMinutes = Math.floor((breakSeconds % 3600) / 60);
                document.getElementById('breakTime').textContent = `${breakHours}h ${breakMinutes}m`;

                // Check if 9 hours effective complete
                const nineHoursInSeconds = 9 * 60 * 60;
                const isComplete = currentEffectiveSeconds >= nineHoursInSeconds;

                // Update remaining time
                updateRemainingTime(exitTime, lastOutTime, isComplete);

                // Update status text based on completion
                if (lastOutTime && isComplete) {
                    document.getElementById('statusText').textContent = '✅ Completed (9h)';
                    document.getElementById('statusIndicator').className = 'status-indicator ok';
                } else if (lastOutTime && !isComplete) {
                    document.getElementById('statusText').textContent = '⏳ Working (< 9h)';
                    document.getElementById('statusIndicator').className = 'status-indicator pending';
                }
            }
        });
    }, 1000);
}

// Format time as 12-hour format (HH:MM:SS AM/PM)
function formatTime(date, includeSeconds = true) {
    let hours = date.getHours();
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const ampm = hours >= 12 ? 'PM' : 'AM';

    // Convert to 12-hour format
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    const hoursStr = pad(hours);

    if (includeSeconds) {
        return `${hoursStr}:${minutes}:${seconds} ${ampm}`;
    } else {
        return `${hoursStr}:${minutes} ${ampm}`;
    }
}

// Pad number with leading zero
function pad(num) {
    return num.toString().padStart(2, '0');
}

// Find today's entry from scraped data
function findTodayEntry(entries) {
    if (!entries || entries.length === 0) {
        return null;
    }

    const today = new Date();
    const todayDay = today.getDate();
    const todayMonth = today.toLocaleString('en-US', { month: 'short' });

    // First, try to find exact match for today
    let found = entries.find(entry => {
        if (!entry.date) return false;

        // Parse the entry date format: "Thu, 13 Nov"
        const dateMatch = entry.date.match(/(\d+)\s+(\w+)/);
        if (dateMatch) {
            const entryDay = parseInt(dateMatch[1]);
            const entryMonth = dateMatch[2];

            return entryDay === todayDay && entryMonth.toLowerCase() === todayMonth.toLowerCase();
        }
        return false;
    });

    // If no exact match, use the most recent entry (first in array)
    if (!found && entries.length > 0) {
        found = entries[0];
    }

    return found;
}

// ============================================
// TOKEN & UI MANAGEMENT
// ============================================

function checkTokenAndUpdateUI() {
    chrome.storage.local.get(['kekaAuthToken'], (data) => {
        const hasToken = data.kekaAuthToken && data.kekaAuthToken.trim().length > 0;

        const fetchBtn = document.getElementById('scrapeManual');
        const kekaBtn = document.getElementById('openKeka');

        if (hasToken) {
            // Token exists - show Fetch Now button, hide Keka button
            fetchBtn.style.display = 'block';
            kekaBtn.style.display = 'none';

            // Auto-fetch data when token is available (only if no data exists yet)
            chrome.storage.local.get(['scrapedAttendance'], (result) => {
                if (!result.scrapedAttendance || !result.scrapedAttendance.entries || result.scrapedAttendance.entries.length === 0) {
                    autoFetchData();
                }
            });
        } else {
            // No token - show Keka button, hide Fetch Now button
            fetchBtn.style.display = 'none';
            kekaBtn.style.display = 'block';
        }
    });
}

function autoFetchData() {
    // Auto-fetch data silently in background
    chrome.runtime.sendMessage({ type: 'FETCH_ATTENDANCE_API' }, (response) => {
        if (response && response.success) {
            console.log('Auto-fetched attendance data successfully');
            loadData();
        }
    });
}

function openKekaWebsite() {
    // Open Keka attendance page in new tab
    chrome.tabs.create({
        url: 'https://acquaint.keka.com/#/me/attendance/logs',
        active: true
    });

    // Show info message
    const statusDiv = document.getElementById('scrapeStatus');
    statusDiv.className = 'scrape-status info';
    statusDiv.textContent = '🔑 Opening Keka... Your token will be captured automatically!';
}

// ============================================
// SCRAPING FUNCTIONS
// ============================================

async function scrapeManual() {
    const statusDiv = document.getElementById('scrapeStatus');
    statusDiv.className = 'scrape-status info';
    statusDiv.textContent = 'Fetching data from Keka API...';

    try {
        // Send message to background script to fetch from API
        chrome.runtime.sendMessage({ type: 'FETCH_ATTENDANCE_API' }, (response) => {
            if (chrome.runtime.lastError) {
                statusDiv.className = 'scrape-status error';
                statusDiv.textContent = 'Error: ' + chrome.runtime.lastError.message;
                return;
            }

            if (response && response.success) {
                statusDiv.className = 'scrape-status success';
                const count = response.data.entries.length;
                statusDiv.textContent = `✓ Fetched ${count} entries successfully from API!`;

                // Reload data
                loadData();
            } else {
                statusDiv.className = 'scrape-status error';
                statusDiv.textContent = response.error || 'Failed to fetch data from API';

                // If token error, update UI to show Keka button
                if (response.error && response.error.includes('Token expired')) {
                    checkTokenAndUpdateUI();
                }
            }
        });

    } catch (error) {
        statusDiv.className = 'scrape-status error';
        statusDiv.textContent = `Error: ${error.message}`;
    }
}

// ============================================
// SETTINGS PAGE
// ============================================

function loadSettingsPage() {
    // Update token status
    chrome.storage.local.get(['kekaAuthToken', 'tokenExtractedAt'], (data) => {
        const badge = document.getElementById('tokenBadge');
        const statusText = document.getElementById('tokenStatusText');
        const details = document.getElementById('tokenDetails');

        if (data.kekaAuthToken && data.kekaAuthToken.trim().length > 0) {
            badge.textContent = '✅ Connected';
            badge.className = 'card-badge connected';
            statusText.textContent = '🎉 You\'re all set! Your magical connection is active.';

            if (data.tokenExtractedAt) {
                const date = new Date(data.tokenExtractedAt);
                details.textContent = `Last synced: ${date.toLocaleString()}`;
            } else {
                details.textContent = 'Token is active and ready!';
            }
        } else {
            badge.textContent = '❌ Not Connected';
            badge.className = 'card-badge disconnected';
            statusText.textContent = '🔌 No connection yet. Click "Connect to Keka Universe" on the home page!';
            details.textContent = '';
        }
    });

    // Render notifications
    renderNotifications();
}

function loadNotifications() {
    chrome.storage.local.get(['notifications'], (data) => {
        notifications = data.notifications || [];
    });
}

function renderNotifications() {
    const container = document.getElementById('notificationsList');

    if (notifications.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">😴</div>
                <div class="empty-state-text">No reminders yet! Click the ➕ button to add one.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
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
        container.appendChild(item);
    });

    // Add event listeners
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
    // Validate notifications
    const validNotifications = notifications.filter(n => n.time && n.description);

    if (validNotifications.length !== notifications.length) {
        alert('Please fill in all notification fields or remove empty ones.');
        return;
    }

    chrome.storage.local.set({ notifications: validNotifications }, () => {
        // Send message to background to update alarms
        chrome.runtime.sendMessage({
            type: 'UPDATE_NOTIFICATIONS',
            notifications: validNotifications
        }, (response) => {
            if (response && response.success) {
                alert('Settings saved successfully! Notifications will trigger at set times.');
            } else {
                alert('Settings saved but there was an issue setting up alarms.');
            }
            closeSettings();
        });
    });
}

function testNotification() {
    chrome.runtime.sendMessage({
        type: 'TEST_NOTIFICATION'
    }, (response) => {
        if (response && response.success) {
            alert('Test notification sent! Check your system notifications.');
        }
    });
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.scrapedAttendance || changes.manualOverride) {
            loadData();
        }

        // If token was added/updated, refresh UI and auto-fetch
        if (changes.kekaAuthToken) {
            checkTokenAndUpdateUI();
        }
    }
});
