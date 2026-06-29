// API sync — replaces direct Supabase cloud-sync.js

const syncLog = createLogger('[API-Sync]');

async function syncTokenToCloud(token, source) {
    if (!API_ENABLED) {
        syncLog.log('API disabled — skip token sync');
        return;
    }
    if (!token) return;

    try {
        const result = await apiSyncKekaToken(source);
        if (result.success) {
            syncLog.log('token synced via API');
            await chrome.storage.local.set({
                lastCloudTokenSync: {
                    status: 'success',
                    message: 'Token sync completed via API',
                    at: new Date().toISOString()
                }
            });
            await flushPendingWorkspaceSessionSync();
        } else {
            syncLog.warn('token sync failed', result.error);
        }
    } catch (err) {
        syncLog.warn('token sync error', err.message);
    }
}

async function syncAttendanceToCloud(token, rawApiItems) {
    if (!API_ENABLED) {
        syncLog.log('API disabled — skip attendance sync');
        return;
    }
    if (!token || !rawApiItems) return;

    try {
        const result = await apiSyncAttendance(rawApiItems);
        if (result.success) {
            syncLog.log('attendance synced via API', result.daysSynced, 'days');
            await chrome.storage.local.set({
                lastCloudAttendanceSync: {
                    status: 'success',
                    message: 'Attendance sync completed via API',
                    at: new Date().toISOString(),
                    details: { daysSynced: result.daysSynced, dates: result.dates }
                }
            });
        } else {
            syncLog.warn('attendance sync failed', result.error);
        }
    } catch (err) {
        syncLog.warn('attendance sync error', err.message);
    }
}
