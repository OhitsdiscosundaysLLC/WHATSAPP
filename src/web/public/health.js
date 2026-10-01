(function () {
  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(path, opts);
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('unauthenticated');
    }
    return res;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  const STATUS_CLASS = {
    ok: 'status-connected',
    connected: 'status-connected',
    degraded: 'status-warn',
    reconnecting: 'status-warn',
    down: 'status-error',
    error: 'status-error',
    not_configured: 'status-neutral',
    not_implemented: 'status-neutral',
    disabled: 'status-neutral',
  };

  const STATUS_LABEL = {
    ok: 'Healthy',
    connected: 'Connected',
    degraded: 'Degraded',
    reconnecting: 'Reconnecting',
    down: 'Disconnected',
    error: 'Error',
    not_configured: 'Misconfigured',
    not_implemented: 'Not configured',
    disabled: 'Disabled',
  };

  function pill(el, status) {
    const cls = STATUS_CLASS[status] || 'status-neutral';
    const label = STATUS_LABEL[status] || status;
    el.innerHTML =
      '<span class="status-pill ' +
      cls +
      '"><span class="status-dot"></span><span>' +
      label +
      '</span></span>';
  }

  const healthError = document.getElementById('health-error');

  async function loadHealth() {
    try {
      const res = await fetch('/health');
      const data = await res.json();

      pill(document.getElementById('app-pill'), data.status);
      document.getElementById('app-detail').textContent =
        'Version ' + data.version + ' · ' + data.env + ' · up ' + formatUptime(data.uptimeSeconds);

      pill(document.getElementById('database-pill'), data.components.database.status);
      document.getElementById('database-detail').textContent =
        data.components.database.detail ||
        (data.components.database.status === 'ok' ? 'Reachable.' : 'See server logs for detail.');

      pill(document.getElementById('storage-pill'), data.components.storage.status);
      pill(document.getElementById('openai-pill'), data.components.openai.status);
    } catch (err) {
      healthError.textContent = 'Could not load system health.';
    }
  }

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  const ACCOUNT_STATUS_LABEL = {
    disabled: 'Disabled',
    initializing: 'Starting…',
    connecting: 'Connecting…',
    awaiting_qr: 'Pairing Required',
    awaiting_pairing_code: 'Pairing Required',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
    logged_out: 'Logged Out',
    error: 'Error',
  };
  const ACCOUNT_STATUS_CLASS = {
    connected: 'status-connected',
    reconnecting: 'status-warn',
    awaiting_qr: 'status-pending',
    awaiting_pairing_code: 'status-pending',
    initializing: 'status-pending',
    connecting: 'status-pending',
    error: 'status-error',
  };

  async function loadAccounts() {
    const list = document.getElementById('account-list');
    const empty = document.getElementById('account-empty');
    try {
      const res = await api('/api/accounts');
      const data = await res.json();
      const accounts = data.accounts || [];
      list.innerHTML = '';
      empty.classList.toggle('hidden', accounts.length > 0);

      for (const account of accounts) {
        const row = document.createElement('div');
        row.className = 'card group-row';

        const main = document.createElement('div');
        main.className = 'group-row-main';
        const subject = document.createElement('div');
        subject.className = 'group-subject';
        subject.textContent = account.label;
        const meta = document.createElement('div');
        meta.className = 'account-meta';
        meta.textContent = account.status.lastConnectedAt
          ? 'Last connected ' + fmtDate(account.status.lastConnectedAt)
          : 'Never connected';
        main.appendChild(subject);
        main.appendChild(meta);

        const pills = document.createElement('div');
        pills.className = 'group-row-pills';
        const cls = ACCOUNT_STATUS_CLASS[account.status.state] || 'status-neutral';
        const label = ACCOUNT_STATUS_LABEL[account.status.state] || account.status.state;
        const span = document.createElement('span');
        span.className = 'status-pill ' + cls;
        span.innerHTML = '<span class="status-dot"></span><span></span>';
        span.querySelector('span:last-child').textContent = label;
        pills.appendChild(span);

        row.appendChild(main);
        row.appendChild(pills);
        list.appendChild(row);
      }
    } catch (err) {
      if (err.message !== 'unauthenticated') healthError.textContent = 'Could not load accounts.';
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadHealth();
  loadAccounts();
})();
