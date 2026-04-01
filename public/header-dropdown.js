(function () {
  const AUTH_TOKEN_KEY = 'authToken';

  function getToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  }

  // ── Modal helpers ──────────────────────────────────────────────
  function createModalEl() {
    const el = document.createElement('div');
    el.className = 'hd-modal-overlay';
    el.id = 'hdModalOverlay';
    document.body.appendChild(el);
    return el;
  }

  function getModal() {
    return document.getElementById('hdModalOverlay') || createModalEl();
  }

  function showConfirmModal({ title, body, icon, confirmText, cancelText }, onConfirm) {
    const overlay = getModal();
    overlay.innerHTML = `
      <div class="hd-modal">
        <div class="hd-modal-icon">${icon || '⚠️'}</div>
        <div class="hd-modal-title">${title}</div>
        <div class="hd-modal-body">${body}</div>
        <div class="hd-modal-actions">
          <button class="hd-modal-btn hd-modal-btn-secondary" id="hdModalCancel">${cancelText || 'Go Back'}</button>
          <button class="hd-modal-btn hd-modal-btn-danger" id="hdModalConfirm">${confirmText || 'Confirm'}</button>
        </div>
      </div>`;
    overlay.classList.add('hd-modal-open');

    document.getElementById('hdModalCancel').onclick = () => overlay.classList.remove('hd-modal-open');
    document.getElementById('hdModalConfirm').onclick = () => {
      overlay.classList.remove('hd-modal-open');
      onConfirm();
    };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('hd-modal-open'); };
  }

  function showInfoModal({ title, body, icon, btnText }) {
    const overlay = getModal();
    overlay.innerHTML = `
      <div class="hd-modal">
        <div class="hd-modal-icon">${icon || 'ℹ️'}</div>
        <div class="hd-modal-title">${title}</div>
        <div class="hd-modal-body">${body}</div>
        <div class="hd-modal-actions">
          <button class="hd-modal-btn hd-modal-btn-primary" id="hdModalOk">${btnText || 'OK'}</button>
        </div>
      </div>`;
    overlay.classList.add('hd-modal-open');
    document.getElementById('hdModalOk').onclick = () => overlay.classList.remove('hd-modal-open');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('hd-modal-open'); };
  }

  function formatCancelDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  // ── Main ───────────────────────────────────────────────────────
  async function initHeaderDropdown() {
    const token = getToken();
    if (!token) return;

    const welcomeEl = document.querySelector('.welcome');
    if (!welcomeEl) return;

    welcomeEl.innerHTML = `
      <span class="hd-trigger">
        Welcome, <span class="welcome-bold hd-username" id="usernameDisplay"><span class="hd-username-shimmer"></span></span>
        <svg class="hd-caret" width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <div class="hd-menu" id="hdMenu">
        <div class="hd-email" id="hdEmail">Loading...</div>
        <div class="hd-divider"></div>
        <div class="hd-premium-row" id="hdPremiumRow" style="display:none;">
          <div class="hd-premium-item">
            <span class="hd-premium-label">&#9733; Charity Stream Premium</span>
            <svg class="hd-chevron-right" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="hd-submenu" id="hdSubmenu">
              <button class="hd-cancel-btn" id="hdCancelBtn">Cancel Subscription</button>
            </div>
          </div>
        </div>
        <div class="hd-divider hd-premium-divider" id="hdPremiumDivider" style="display:none;"></div>
        <button class="hd-logout-btn" id="hdLogoutBtn">Log out</button>
      </div>
    `;

    welcomeEl.classList.add('hd-wrapper');

    // Fetch user info
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const user = data.user;

        const emailEl = document.getElementById('hdEmail');
        if (emailEl) emailEl.textContent = user.email || '';

        const usernameEl = document.getElementById('usernameDisplay');
        if (usernameEl) {
          usernameEl.textContent = user.username || user.email?.split('@')[0] || 'User';
          if (user.isPremium) usernameEl.classList.add('hd-username-premium');
          usernameEl.classList.remove('hd-username-shimmer');
        }

        if (user.isPremium) {
          const premiumRow = document.getElementById('hdPremiumRow');
          const premiumDivider = document.getElementById('hdPremiumDivider');
          if (premiumRow) premiumRow.style.display = 'block';
          if (premiumDivider) premiumDivider.style.display = 'block';

          // If subscription is already cancelled but still active, show end date instead
          if (user.subscriptionCancelAt) {
            const cancelBtn = document.getElementById('hdCancelBtn');
            if (cancelBtn) {
              cancelBtn.textContent = `Subscription ends ${formatCancelDate(user.subscriptionCancelAt)}`;
              cancelBtn.classList.add('hd-cancel-btn-ending');
              cancelBtn.disabled = true;
            }
          }
        }
      }
    } catch (e) {
      console.error('Header dropdown: failed to load user info', e);
    }

    // Logout
    document.getElementById('hdLogoutBtn')?.addEventListener('click', function () {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem('currentUser');
      window.location.href = '/';
    });

    // Cancel subscription
    document.getElementById('hdCancelBtn')?.addEventListener('click', function () {
      // If already cancelled (button disabled), do nothing
      if (this.disabled) return;

      showConfirmModal({
        icon: '💛',
        title: 'Cancel Premium?',
        body: 'You\'ll keep your Premium access until the end of your current billing period. We\'re sorry to see you go!',
        confirmText: 'Yes, cancel',
        cancelText: 'Keep Premium'
      }, async () => {
        const btn = document.getElementById('hdCancelBtn');
        if (btn) { btn.textContent = 'Cancelling...'; btn.disabled = true; }

        try {
          const r = await fetch('/api/subscribe/cancel', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const d = await r.json();
          if (r.ok) {
            const endDate = d.cancelAt ? formatCancelDate(d.cancelAt) : 'the end of your billing period';
            showInfoModal({
              icon: '✅',
              title: 'Subscription Cancelled',
              body: `Your subscription has been cancelled. You'll keep Premium access until ${endDate}.`,
              btnText: 'Got it'
            });
            // Update button to show end date instead of hiding the premium row
            if (btn && d.cancelAt) {
              btn.textContent = `Subscription ends ${formatCancelDate(d.cancelAt)}`;
              btn.classList.add('hd-cancel-btn-ending');
              btn.disabled = true;
            } else if (btn) {
              btn.textContent = 'Subscription Cancelled';
              btn.disabled = true;
            }
          } else {
            showInfoModal({
              icon: '❌',
              title: 'Something went wrong',
              body: d.error || 'Failed to cancel subscription. Please try again.',
              btnText: 'Close'
            });
            if (btn) { btn.textContent = 'Cancel Subscription'; btn.disabled = false; }
          }
        } catch (e) {
          showInfoModal({
            icon: '❌',
            title: 'Something went wrong',
            body: 'Could not reach the server. Please try again.',
            btnText: 'Close'
          });
          if (btn) { btn.textContent = 'Cancel Subscription'; btn.disabled = false; }
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeaderDropdown);
  } else {
    initHeaderDropdown();
  }
})();
