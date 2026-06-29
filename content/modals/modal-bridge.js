// Bridge background alerts to modal UI on page

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'SHOW_TRACKER_ALERT') {
        const config = request.config;
        if (!config) {
            sendResponse({ success: false });
            return;
        }

        if (config.variant === 'eod') {
            if (typeof showEodModalContent === 'function') {
                showEodModalContent(config);
            }
        } else if (typeof showTrackerModal === 'function') {
            showTrackerModal(config);
        }

        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'showEodModal') {
        if (typeof showEodModal === 'function') {
            showEodModal(request.suggestedMessage);
        }
        sendResponse({ success: true });
        return true;
    }
});
