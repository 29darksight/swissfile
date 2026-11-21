import { $, showToast, logLine } from './dom.js';

export function initBugReporting() {
  const modal = $('#bugModal');
  const openBtn = $('#bugReportBtn');
  const closeBtn = $('#bugModalCloseBtn');
  const cancelBtn = $('#bugCancelBtn');
  const form = $('#bugReportForm');
  const submitBtn = $('#bugSubmitBtn');
  const honey = $('#bugHoney');

  if (!modal || !form) return;

  const openModal = () => {
    modal.classList.remove('hidden');
    $('#bugEmail')?.focus();
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    form.reset();
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Report';
    }
  };

  openBtn?.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Honeypot check to block automated spam bots
    if (honey && honey.value.trim().length > 0) {
      closeModal();
      return;
    }

    const email = $('#bugEmail')?.value.trim();
    const title = $('#bugTitle')?.value.trim();
    const description = $('#bugDesc')?.value.trim();

    if (!email || !title || !description) {
      showToast('Please fill all required fields.', 'warn');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
      const resp = await fetch('https://formsubmit.co/ajax/contact@swissfile.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email,
          _subject: `[SwissFile Bug] ${title}`,
          message: description,
          _template: 'table'
        })
      });

      if (resp.ok) {
        showToast('Bug report sent! Thank you.', 'success');
        logLine(`Bug report submitted: ${title}`);
        closeModal();
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      logLine(`Bug report error: ${err.message}`);
      showToast('Submission failed. Please email contact@swissfile.dev directly.', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Report';
    }
  });
}
