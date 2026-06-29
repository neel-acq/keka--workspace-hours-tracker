// Generic tracker modal — full-screen page overlay

const KHT_MODAL_ID = 'kht-tracker-modal';

function khtEscapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function khtEscapeHtmlAttr(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function closeTrackerModal() {
    const modal = document.getElementById(KHT_MODAL_ID);
    if (modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 300);
    }
}

function showKhtToast(text, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `kht-toast kht-toast-${type}`;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('visible'), 10);
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function handleAlertAction(alertId, actionId) {
    chrome.runtime.sendMessage({
        type: 'TRACKER_ALERT_ACTION',
        alertId,
        actionId
    });
}

async function showTrackerModal(config) {
    if (config.variant === 'eod') {
        if (typeof showEodModalContent === 'function') {
            return showEodModalContent(config);
        }
        return;
    }

    const existing = document.getElementById(KHT_MODAL_ID);
    if (existing) {
        existing.classList.add('visible');
        return;
    }

    const labelHtml = config.label
        ? `<span class="kht-modal-label">${khtEscapeHtml(config.label)}</span>`
        : '';
    const messageHtml = config.message
        ? `<p class="kht-instruction">${khtEscapeHtml(config.message)}</p>`
        : '';

    const actions = Array.isArray(config.actions) ? config.actions : [];
    const footerHtml = actions.map((action) => {
        const cls = action.primary ? 'kht-btn-primary' : 'kht-btn-secondary';
        return `<button type="button" class="${cls} kht-action-btn" data-action-id="${khtEscapeHtmlAttr(action.id)}">${khtEscapeHtml(action.label)}</button>`;
    }).join('');

    const modal = document.createElement('div');
    modal.id = KHT_MODAL_ID;
    modal.className = 'kht-modal-overlay';
    modal.dataset.alertId = config.id || '';

    modal.innerHTML = `
        <div class="kht-modal-content">
            <div class="kht-modal-header">
                <div class="kht-modal-header-text">
                    ${labelHtml}
                    <h3>${khtEscapeHtml(config.title || 'Keka Hours Tracker')}</h3>
                </div>
                <button type="button" class="kht-close-btn" aria-label="Close">&times;</button>
            </div>
            <div class="kht-modal-body">${messageHtml}</div>
            <div class="kht-modal-footer">${footerHtml}</div>
        </div>
    `;

    document.body.appendChild(modal);

    const close = () => closeTrackerModal();

    modal.querySelector('.kht-close-btn').addEventListener('click', close);

    modal.querySelectorAll('.kht-action-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const actionId = btn.getAttribute('data-action-id');
            handleAlertAction(config.id, actionId);
            close();
        });
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });

    requestAnimationFrame(() => modal.classList.add('visible'));
}

window.showTrackerModal = showTrackerModal;
window.closeTrackerModal = closeTrackerModal;
window.showKhtToast = showKhtToast;
window.khtEscapeHtml = khtEscapeHtml;
window.khtEscapeHtmlAttr = khtEscapeHtmlAttr;
