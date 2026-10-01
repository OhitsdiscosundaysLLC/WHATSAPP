(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  const STATUS_META = {
    disabled: { label: 'Disabled', cls: 'status-neutral' },
    initializing: { label: 'Starting…', cls: 'status-pending' },
    connecting: { label: 'Connecting…', cls: 'status-pending' },
    awaiting_qr: { label: 'Pairing Required (QR)', cls: 'status-pending' },
    awaiting_pairing_code: { label: 'Pairing Required (Code)', cls: 'status-pending' },
    connected: { label: 'Connected', cls: 'status-connected' },
    reconnecting: { label: 'Reconnecting…', cls: 'status-warn' },
    disconnected: { label: 'Disconnected', cls: 'status-neutral' },
    logged_out: { label: 'Logged Out', cls: 'status-neutral' },
    error: { label: 'Error', cls: 'status-error' },
  };

  const PAIRING_STATES = new Set([
    'initializing',
    'connecting',
    'awaiting_qr',
    'awaiting_pairing_code',
  ]);
  const RECONNECTABLE_STATES = new Set(['disconnected', 'logged_out', 'error']);

  async function api(path, options) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({}, opts.headers);
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrfToken;

    const res = await fetch(path, Object.assign({}, opts, { method, headers }));
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('unauthenticated');
    }
    return res;
  }

  function statusMeta(state) {
    return STATUS_META[state] || { label: state, cls: 'status-neutral' };
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  // ---------- Account grid ----------

  const grid = document.getElementById('account-grid');
  const emptyState = document.getElementById('empty-state');
  const accountsError = document.getElementById('accounts-error');

  function renderAccounts(accounts) {
    grid.innerHTML = '';
    emptyState.classList.toggle('hidden', accounts.length > 0);

    for (const account of accounts) {
      grid.appendChild(renderAccountCard(account));
    }
  }

  function renderAccountCard(account) {
    const meta = statusMeta(account.status.state);

    const card = document.createElement('div');
    card.className = 'card account-card';

    const top = document.createElement('div');
    top.className = 'account-card-top';

    const labelWrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'account-label';
    label.textContent = account.label;
    const createdMeta = document.createElement('div');
    createdMeta.className = 'account-meta';
    createdMeta.textContent = 'Added ' + fmtDate(account.createdAt);
    labelWrap.appendChild(label);
    labelWrap.appendChild(createdMeta);

    const pill = document.createElement('span');
    pill.className = 'status-pill ' + meta.cls;
    pill.innerHTML = '<span class="status-dot"></span><span></span>';
    pill.querySelector('span:last-child').textContent = meta.label;

    top.appendChild(labelWrap);
    top.appendChild(pill);
    card.appendChild(top);

    if (account.status.lastConnectedAt) {
      const lastConnected = document.createElement('div');
      lastConnected.className = 'account-meta';
      lastConnected.textContent = 'Last connected ' + fmtDate(account.status.lastConnectedAt);
      card.appendChild(lastConnected);
    }
    if (account.status.detail) {
      const detail = document.createElement('div');
      detail.className = 'account-meta';
      detail.textContent = account.status.detail;
      card.appendChild(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    if (PAIRING_STATES.has(account.status.state)) {
      actions.appendChild(
        makeButton('Show QR', 'btn-sm', () => openPairingModal(account.id, account.label)),
      );
    }
    if (account.status.state === 'connected') {
      actions.appendChild(
        makeButton('Disconnect', 'btn-sm', () =>
          doAction(
            account.id,
            'disconnect',
            'Disconnect this account? It will need to be re-paired.',
          ),
        ),
      );
    }
    if (RECONNECTABLE_STATES.has(account.status.state)) {
      actions.appendChild(
        makeButton('Reconnect', 'btn-sm btn-primary', () => {
          doAction(account.id, 'reconnect').then(() => openPairingModal(account.id, account.label));
        }),
      );
    }
    actions.appendChild(
      makeButton('Remove', 'btn-sm btn-danger', () =>
        doAction(
          account.id,
          null,
          'Remove this account and erase its local session? This cannot be undone.',
          'DELETE',
        ),
      ),
    );

    card.appendChild(actions);
    return card;
  }

  function makeButton(text, extraClass, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + extraClass;
    btn.textContent = text;
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  async function doAction(id, action, confirmMessage, method) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    try {
      const path = action ? '/api/accounts/' + id + '/' + action : '/api/accounts/' + id;
      await api(path, { method: method || 'POST' });
      await loadAccounts();
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        accountsError.textContent = 'Action failed — please try again.';
      }
    }
  }

  async function loadAccounts() {
    accountsError.textContent = '';
    try {
      const res = await api('/api/accounts');
      const data = await res.json();
      renderAccounts(data.accounts || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        accountsError.textContent = 'Could not load accounts.';
      }
    }
  }

  // ---------- Add account ----------

  document.getElementById('add-account-btn').addEventListener('click', async () => {
    const label = window.prompt('Name this WhatsApp account (e.g. "Support Line"):', '');
    if (label === null) return;
    try {
      const res = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
      const data = await res.json();
      await loadAccounts();
      openPairingModal(data.account.id, data.account.label);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        accountsError.textContent = 'Could not create account.';
      }
    }
  });

  // ---------- Pairing modal ----------

  const modal = document.getElementById('pairing-modal');
  const pairingTitle = document.getElementById('pairing-title');
  const pairingStatusPill = document.getElementById('pairing-status');
  const pairingStatusText = document.getElementById('pairing-status-text');
  const qrBox = document.getElementById('qr-box');
  const pairingError = document.getElementById('pairing-error');
  const phoneInput = document.getElementById('phone-input');
  const pairingCodeBox = document.getElementById('pairing-code-box');

  let activeEventSource = null;
  let activeAccountId = null;

  function setActiveTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('tab-qr').classList.toggle('hidden', tab !== 'qr');
    document.getElementById('tab-code').classList.toggle('hidden', tab !== 'code');
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  function openPairingModal(accountId, label) {
    activeAccountId = accountId;
    pairingTitle.textContent = 'Link "' + label + '"';
    pairingError.textContent = '';
    pairingCodeBox.classList.add('hidden');
    phoneInput.value = '';
    qrBox.innerHTML = '<span class="muted">Generating QR code…</span>';
    setActiveTab('qr');
    modal.classList.remove('hidden');

    if (activeEventSource) activeEventSource.close();
    activeEventSource = new EventSource('/api/accounts/' + accountId + '/events');
    activeEventSource.addEventListener('status', (event) => {
      const snapshot = JSON.parse(event.data);
      renderPairingStatus(snapshot);
    });
    activeEventSource.onerror = () => {
      // EventSource auto-reconnects; nothing to do here besides leaving the
      // last known state visible.
    };
  }

  function renderPairingStatus(snapshot) {
    const meta = statusMeta(snapshot.state);
    pairingStatusPill.className = 'status-pill ' + meta.cls;
    pairingStatusText.textContent = meta.label;

    if (snapshot.qrImage) {
      qrBox.innerHTML = '';
      const img = document.createElement('img');
      img.src = snapshot.qrImage;
      img.alt = 'WhatsApp pairing QR code';
      qrBox.appendChild(img);
    } else if (snapshot.state !== 'connected') {
      qrBox.innerHTML = '<span class="muted">Waiting for a QR code…</span>';
    }

    if (snapshot.pairingCode) {
      pairingCodeBox.textContent = snapshot.pairingCode;
      pairingCodeBox.classList.remove('hidden');
    }

    if (snapshot.state === 'connected') {
      qrBox.innerHTML = '<span style="color: var(--accent); font-weight: 600">✓ Connected!</span>';
      loadAccounts();
      setTimeout(closePairingModal, 1500);
    } else if (snapshot.state === 'error' || snapshot.state === 'logged_out') {
      loadAccounts();
    }
  }

  function closePairingModal() {
    modal.classList.add('hidden');
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    activeAccountId = null;
  }

  document.getElementById('pairing-close').addEventListener('click', closePairingModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closePairingModal();
  });

  document.getElementById('request-code-btn').addEventListener('click', async () => {
    if (!activeAccountId) return;
    pairingError.textContent = '';
    const phoneNumber = phoneInput.value.trim();
    try {
      const res = await api('/api/accounts/' + activeAccountId + '/pairing-code', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        pairingError.textContent = data.message || 'Could not get a pairing code.';
        return;
      }
      const data = await res.json();
      pairingCodeBox.textContent = data.code;
      pairingCodeBox.classList.remove('hidden');
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        pairingError.textContent = 'Could not reach the server.';
      }
    }
  });

  // ---------- Logout ----------

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  // ---------- Init ----------

  loadAccounts();
})();
