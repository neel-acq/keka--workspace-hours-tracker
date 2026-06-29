// API sync — replaces direct Supabase cloud-sync.js

const SYNC_LOG = '[API-Sync]';

async function syncTokenToCloud(token, source) {
    if (!API_ENABLED) {
        console.log(SYNC_LOG, 'API disabled — skip token sync');
        return;
    }
    if (!token) return;

    try {
        const result = await apiSyncKekaToken(source);
        if (result.success) {
            console.log(SYNC_LOG, 'token synced via API');
            await chrome.storage.local.set({
                lastCloudTokenSync: {
                    status: 'success',
                    message: 'Token sync completed via API',
                    at: new Date().toISOString()
                }
            });
            await flushPendingWorkspaceSessionSync();
        } else {
            console.warn(SYNC_LOG, 'token sync failed', result.error);
        }
    } catch (err) {
        console.warn(SYNC_LOG, 'token sync error', err.message);
    }
}

async function syncAttendanceToCloud(token, rawApiItems) {
    if (!API_ENABLED) {
        console.log(SYNC_LOG, 'API disabled — skip attendance sync');
        return;
    }
    if (!token || !rawApiItems) return;

    try {
        const result = await apiSyncAttendance(rawApiItems);
        if (result.success) {
            console.log(SYNC_LOG, 'attendance synced via API', result.daysSynced, 'days');
            await chrome.storage.local.set({
                lastCloudAttendanceSync: {
                    status: 'success',
                    message: 'Attendance sync completed via API',
                    at: new Date().toISOString(),
                    details: { daysSynced: result.daysSynced, dates: result.dates }
                }
            });
        } else {
            console.warn(SYNC_LOG, 'attendance sync failed', result.error);
        }
    } catch (err) {
        console.warn(SYNC_LOG, 'attendance sync error', err.message);
    }
}
