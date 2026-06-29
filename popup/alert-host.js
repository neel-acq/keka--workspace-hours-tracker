// Extension popup window fallback for tracker alerts

document.addEventListener('DOMContentLoaded', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PENDING_TRACKER_ALERT' });
    const config = response?.config;

    if (!config) {
        window.close();
        return;
    }

    if (config.variant === 'eod' && typeof showEodModalContent === 'function') {
        await showEodModalContent(config);
    } else if (typeof showTrackerModal === 'function') {
        await showTrackerModal(config);
    }

    chrome.storage.local.remove('pendingTrackerAlert');
});
