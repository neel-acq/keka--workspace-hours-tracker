# Keka Hours Tracker Chrome Extension

A Chrome extension to automatically fetch and track your Keka attendance data with real-time calculations, smart notifications, and intelligent exit time management.

## 🚀 New Features

### 🟢 Smart Entry Time Management
- **Early Bird Rule**: If you enter before 10:00 AM, your target exit time is automatically set to 7:00 PM
- **Standard Rule**: If you enter after 10:00 AM, your target exit time is calculated as entry time + 9 hours
- **Visual Indicators**: Early entries show a special "Early Bird! 🌅" badge with glowing animation

### ⏰ Freedom Countdown
- Live countdown timer showing time remaining until you can leave
- Dynamic messages based on entry time:
  - Early entries: "Countdown to 7 PM freedom! 🚀"
  - Standard entries: "Time until you can escape! 🚀"
- Special "Freedom Time!" message when target time is reached

### 🎯 Intelligent Target Exit Display
- Shows your calculated exit time based on entry rules
- Updates label dynamically:
  - Early entries: "🎯 Freedom Time (7 PM)"
  - Standard entries: "🎯 Target Exit"

### 🔔 Enhanced Smart Notifications
- 8-hour effective work completion notification
- Target exit time notification with context-aware messaging:
  - Early entries: "🎯 7 PM Freedom Time! You can leave now! 🚀"
  - Standard entries: "🎯 Target Exit Time! You can leave now."
- 10-minute warning before exit time with appropriate messaging

## Features

✅ **Auto Token Capture**: Automatically captures authentication token when you visit Keka website  
✅ **API Data Fetching**: Fetch attendance data from anywhere - no need to open Keka page  
✅ **Real-Time Tracking**: Live updates for Gross Hours, Effective Hours, and Break Time  
✅ **Multiple IN/OUT Support**: Handles multiple check-ins and check-outs throughout the day  
✅ **Smart Exit Time Calculations**:
   - Early Entry (< 10 AM): Target exit at 7:00 PM
   - Standard Entry (≥ 10 AM): Target exit at entry time + 9 hours
   - Gross Hours Worked (total time from first IN to last OUT)
   - Effective Hours Worked (actual working time excluding breaks)
   - Total Break Time (time between OUT and next IN)
   - Remaining Time (live countdown with smart messaging)
✅ **Custom Notifications**: Set up personalized time-based notifications  
✅ **Context-Aware Default Notifications**: Auto-notifications at 8h and target exit with appropriate messaging  
✅ **Professional Punch Card**: Beautifully designed collapsible IN/OUT timeline with classic color scheme  
✅ **Enhanced Freedom Countdown**: Eye-catching countdown banner with dynamic subtitles and professional gradient design  
✅ **Auto-Magic Sync**: Elegant sync card with smooth animations and professional styling  
✅ **Multi-Language Support**: Switch between English, Gujarati (ગુજરાતી), and Hindi (हिंदी)  
✅ **Dark Mode**: Toggle between light and dark themes  
✅ **Premium UI**: Professional classic color combinations with smooth animations and modern design

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right corner)
3. Click "Load unpacked"
4. Select the extension folder
5. Pin the extension by clicking the puzzle icon in Chrome toolbar

## Usage

### First Time Setup

1. **Auto Token Capture**: Visit your Keka website (https://*.keka.com/*) and the extension will automatically capture your authentication token
2. You'll see a notification confirming the token was captured

### Fetch Attendance Data

1. Click the extension icon
2. Click "Fetch Now" button
3. The extension fetches your last 7 days of attendance data from Keka API
4. Works from anywhere - no need to be on Keka page!

### View Your Data

The popup displays:
- **First IN**: Your first check-in time of the day
- **Last OUT**: Your last check-out time (or "Pending" if still working)
- **Gross Hours Worked**: Total time from first IN to last OUT (updates in real-time)
- **Effective Hours Worked**: Actual working time excluding breaks (updates in real-time)
- **Total Break Time**: Time spent on breaks between OUT and IN
- **Expected Exit (9h)**: When you'll complete 9 hours
- **Effective End (8h)**: When you'll complete 8 hours
- **Remaining Time**: Live countdown to 9h completion
- **IN/OUT Timeline**: Detailed list of all your check-ins and check-outs

### Custom Notifications

1. Click the settings icon (⚙️)
2. Click "+ Add Notification"
3. Set time and description (e.g., "5:30 PM - Time to leave")
4. Click "Save Settings"
5. You'll receive notifications at your specified times

### Default Notifications

The extension automatically notifies you when:
- You complete 8 hours (effective hours)
- You complete 9 hours (gross hours)

### Language Selection

1. Click the settings icon (⚙️)
2. Go to "General Settings" tab
3. Select your preferred language from the dropdown:
   - 🇬🇧 English
   - 🇮🇳 ગુજરાતી (Gujarati)
   - 🇮🇳 हिंदी (Hindi)
4. The interface updates instantly with funny, relatable descriptions!

### Dark Mode

Click the moon/sun icon (🌙/☀️) in the top-right to toggle dark mode.

## How It Works

### Auto Token Capture
- When you visit Keka website, the extension intercepts network requests
- Automatically captures your Bearer authentication token
- Stores it securely in local storage
- Shows a notification when token is captured

### API Data Fetching
- Uses the captured token to fetch attendance data from Keka API
- Retrieves last 7 days of attendance records
- Parses all IN/OUT swipes with timestamps
- Works from anywhere - no need to be on Keka page

### Real-Time Calculations
- Updates every second while you're working
- Calculates effective hours (actual work time)
- Tracks break time between OUT and IN swipes
- Computes gross hours (effective + breaks)
- Shows live countdown to completion

### Folder Structure

```
keka-hours-tracker/
├── manifest.json           # Extension configuration
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.js           # Popup logic & real-time calculations
│   └── popup.css          # Popup styling
├── content/
│   └── content.js         # Content script for Keka website
├── background/
│   └── background.js      # Background worker, API calls, notifications
├── assets/
│   ├── icon16.png         # Extension icons
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### Permissions

- `storage`: Store attendance data and settings locally
- `alarms`: Schedule time-based notifications
- `notifications`: Show Chrome notifications
- `webRequest`: Capture authentication token from network requests
- `host_permissions`: Access Keka website (https://*.keka.com/*)

## Troubleshooting

### Token Not Captured

1. Visit your Keka website (https://*.keka.com/*)
2. Log in if not already logged in
3. Navigate around the site (dashboard, attendance page)
4. The extension will capture the token automatically
5. You'll see a notification when successful

### "No authentication token found" Error

1. Visit Keka website to trigger auto-capture
2. Wait for the notification confirming token capture
3. Try fetching data again

### Token Expired (401 Error)

1. The extension will automatically clear the expired token
2. Visit Keka website again to capture a fresh token
3. Tokens typically expire after 24 hours

### Data Not Updating

1. Click "Fetch Now" to refresh data from Keka API
2. Check if you have attendance records for the last 7 days
3. Ensure you're logged into Keka in the same browser

### Notifications Not Appearing

1. Check Chrome notification permissions (chrome://settings/content/notifications)
2. Ensure notifications are enabled for Chrome
3. Test notifications using the "Test Notification" button in settings

### Real-Time Updates Not Working

1. Close and reopen the popup
2. The countdown updates every second automatically
3. Ensure you have fetched data using "Fetch Now"

## Privacy & Security

- All data is stored locally using `chrome.storage.local`
- Authentication token is captured and stored securely on your device
- No data is sent to external servers (except Keka's official API)
- Your attendance data remains private and local to your browser

## License

MIT License - Feel free to modify and use as needed.
