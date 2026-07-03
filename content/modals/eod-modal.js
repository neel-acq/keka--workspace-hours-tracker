// EOD Teams modal variant

const DEFAULT_EOD_MESSAGES = [
    'Good Morning.',
    'Going For Break.',
    'Back from Break.',
    'Leaving for the day',
    'Done for today, see you tomorrow!'
];

const EOD_MODAL_ID = 'kht-eod-modal';
const TIMESHEET_URL = 'https://workspace.acquaintsoft.com/admin/staff/timesheets';
let eodModalOpening = false;

function bindModalEscapeClose(modalEl, closeFn) {
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeFn();
            document.removeEventListener('keydown', onKeyDown);
        }
    };
    document.addEventListener('keydown', onKeyDown);
    return onKeyDown;
}

async function showEodModalContent(config) {
    config = config || {};

    const existing = document.getElementById(EOD_MODAL_ID);
    if (existing) {
        existing.classList.add('visible');
        return;
    }

    if (eodModalOpening) return;
    eodModalOpening = true;

    try {
    const storage = await chrome.storage.local.get({
        teamsPrewrittenMessages: DEFAULT_EOD_MESSAGES,
        teamsConversationId: '',
        teamsFromId: '',
        teamsDisplayName: '',
        teamsSkypeToken: '',
        teamsTokenExpiry: 0,
        darkMode: false,
        language: 'en'
    });

    const configIncomplete = !storage.teamsConversationId
        || !storage.teamsDisplayName
        || (!storage.teamsFromId && !storage.teamsSkypeToken);

    chrome.runtime.sendMessage({ type: 'ENSURE_CREDENTIALS', source: 'eod_modal_open' }).catch(() => {});

    const existingAfterAwait = document.getElementById(EOD_MODAL_ID);
    if (existingAfterAwait) {
        existingAfterAwait.classList.add('visible');
        return;
    }

    let suggestion = config.suggestedMessage;
    if (!suggestion) {
        const response = await chrome.runtime.sendMessage({ type: 'GET_SMART_EOD_SUGGESTION' });
        suggestion = response?.suggestion || DEFAULT_EOD_MESSAGES[0];
    }

    const messages = Array.isArray(storage.teamsPrewrittenMessages) && storage.teamsPrewrittenMessages.length
        ? storage.teamsPrewrittenMessages
        : DEFAULT_EOD_MESSAGES;

    const strings = config.strings || {};
    const title = config.title || strings.eod_modal_title || 'Send update to Teams';
    const label = config.label || strings.eod_modal_label || 'EOD';
    const instruction = strings.eod_modal_instruction || 'Select a message to send to your group:';
    const customToggle = strings.eod_custom_toggle || 'Write a Custom Message...';
    const sendCustom = strings.eod_send_custom || 'Send Custom Message';
    const skipLabel = strings.alert_dismiss || 'Skip';
    const suggestedPrefix = strings.eod_suggested_prefix || 'Suggested:';
    const openTimesheetLabel = strings.eod_open_timesheet || 'Open Timesheet';
    const showOpenTimesheet = config.reason === 'timer_stop';
    const configBanner = configIncomplete
        ? `<div class="kht-config-banner">${khtEscapeHtml(strings.eod_config_incomplete_banner || 'Teams is not fully configured. You can still pick a message; sending may fail until you save settings in the extension Workspace tab.')}</div>`
        : '';

    let messagesHtml = '';
    messages.forEach((msg) => {
        const isSuggested = msg === suggestion;
        messagesHtml += `<button type="button" class="kht-msg-btn kht-prewritten-btn${isSuggested ? ' kht-suggested' : ''}" data-msg="${khtEscapeHtmlAttr(msg)}">${khtEscapeHtml(msg)}</button>`;
    });
    messagesHtml += `<button type="button" id="kht-show-custom-btn" class="kht-msg-btn kht-custom-toggle">${khtEscapeHtml(customToggle)}</button>`;

    const contextMessage = config.message
        ? `<p class="kht-instruction">${khtEscapeHtml(config.message)}</p>`
        : '';

    const modal = document.createElement('div');
    modal.id = EOD_MODAL_ID;
    modal.className = 'kht-modal-overlay';
    modal.dataset.alertId = config.id || 'eod';

    modal.innerHTML = `
        <div class="kht-modal-content">
            <div class="kht-modal-header">
                <div class="kht-modal-header-text">
                    <span class="kht-modal-label">${khtEscapeHtml(label)}</span>
                    <h3>${khtEscapeHtml(title)}</h3>
                </div>
                <button type="button" class="kht-close-btn" aria-label="Close">&times;</button>
            </div>
            <div class="kht-modal-body">
                ${contextMessage}
                ${configBanner}
                ${suggestion ? `<div class="kht-suggestion-banner">${khtEscapeHtml(suggestedPrefix)} <strong>${khtEscapeHtml(suggestion)}</strong></div>` : ''}
                <p class="kht-instruction">${khtEscapeHtml(instruction)}</p>
                <div id="kht-buttons-list">${messagesHtml}</div>
                <div id="kht-custom-section" class="kht-custom-section" style="display:none;">
                    <input type="text" id="kht-custom-input" class="kht-custom-input" placeholder="${khtEscapeHtmlAttr(strings.eod_custom_placeholder || 'Type your message here...')}">
                    <button type="button" id="kht-send-custom-btn" class="kht-btn-primary">${khtEscapeHtml(sendCustom)}</button>
                </div>
            </div>
            <div class="kht-modal-footer">
                ${showOpenTimesheet ? `<button type="button" id="kht-open-timesheet-btn" class="kht-btn-secondary">${khtEscapeHtml(openTimesheetLabel)}</button>` : ''}
                <button type="button" id="kht-skip-btn" class="kht-btn-secondary">${khtEscapeHtml(skipLabel)}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeEod = () => {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 300);
    };

    modal.querySelector('.kht-close-btn').addEventListener('click', closeEod);
    modal.querySelector('#kht-skip-btn').addEventListener('click', closeEod);

    const openTimesheetBtn = modal.querySelector('#kht-open-timesheet-btn');
    if (openTimesheetBtn) {
        openTimesheetBtn.addEventListener('click', () => {
            window.open(TIMESHEET_URL, '_blank');
        });
    }

    bindModalEscapeClose(modal, closeEod);

    modal.querySelectorAll('.kht-prewritten-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            sendEodTeamsMessage(btn.getAttribute('data-msg'), btn, closeEod);
        });
    });

    const customBtn = modal.querySelector('#kht-show-custom-btn');
    const customSection = modal.querySelector('#kht-custom-section');
    const customInput = modal.querySelector('#kht-custom-input');

    customBtn.addEventListener('click', () => {
        customSection.style.display = 'flex';
        customBtn.style.display = 'none';
        customInput.focus();
    });

    modal.querySelector('#kht-send-custom-btn').addEventListener('click', (e) => {
        const msg = customInput.value.trim();
        if (msg) {
            sendEodTeamsMessage(msg, e.target, closeEod);
        } else {
            customInput.classList.add('kht-input-error');
            setTimeout(() => customInput.classList.remove('kht-input-error'), 1500);
        }
    });

    customInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const msg = e.target.value.trim();
            if (msg) {
                sendEodTeamsMessage(msg, modal.querySelector('#kht-send-custom-btn'), closeEod);
            }
        }
    });

    requestAnimationFrame(() => modal.classList.add('visible'));
    } finally {
        eodModalOpening = false;
    }
}

function sendEodTeamsMessage(message, btnElement, closeFn) {
    const originalText = btnElement.textContent;
    btnElement.textContent = 'Sending...';
    btnElement.disabled = true;

    chrome.runtime.sendMessage({ type: 'SEND_TEAMS_MESSAGE', message }, (response) => {
        if (response && response.success) {
            closeFn();
            showKhtToast('Message sent to Teams');
        } else {
            btnElement.textContent = originalText;
            btnElement.disabled = false;
            showKhtToast(`Failed: ${response?.error || 'Unknown error'}`, 'error');
        }
    });
}

window.showEodModal = async function (suggestedMessage) {
    return showEodModalContent({
        variant: 'eod',
        reason: 'timer_stop',
        suggestedMessage
    });
};

window.showEodModalContent = showEodModalContent;

function closeEodModal() {
    const modal = document.getElementById(EOD_MODAL_ID);
    if (modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 300);
    }
}

window.closeEodModal = closeEodModal;
