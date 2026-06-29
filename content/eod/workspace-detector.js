// Detect workspace timer stop actions and trigger EOD modal

if (sessionStorage.getItem('eod_modal_pending')) {
    sessionStorage.removeItem('eod_modal_pending');
    setTimeout(() => {
        if (typeof window.showEodModal === 'function') window.showEodModal();
    }, 1000);
}

document.addEventListener('click', async (e) => {
    let target = e.target;
    let isStopAction = false;

    while (target && target !== document) {
        const onclick = target.getAttribute('onclick') || '';
        const href = target.getAttribute('href') || '';

        if (
            onclick.includes('timer_action') ||
            onclick.includes('timer_tracking') ||
            href.includes('timer_tracking')
        ) {
            isStopAction = true;
            break;
        }
        target = target.parentNode;
    }

    if (!isStopAction) return;

    const { eodEnabled } = await chrome.storage.local.get({ eodEnabled: true });
    if (eodEnabled === false) return;

    sessionStorage.setItem('eod_modal_pending', 'true');

    setTimeout(() => {
        sessionStorage.removeItem('eod_modal_pending');
        if (typeof window.showEodModal === 'function') {
            window.showEodModal();
        }
    }, 800);
}, true);
