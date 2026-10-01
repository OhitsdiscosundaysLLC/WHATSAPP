(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

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

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function renderNumberList(container, emptyEl, numbers) {
    container.innerHTML = '';
    emptyEl.classList.toggle('hidden', numbers.length > 0);
    for (const number of numbers) {
      const row = document.createElement('div');
      row.className = 'activity-item';
      row.textContent = number;
      container.appendChild(row);
    }
  }

  const adminsError = document.getElementById('admins-error');
  const accountSelect = document.getElementById('admin-account');
  let accountLabels = {};

  async function load() {
    adminsError.textContent = '';
    try {
      const res = await api('/api/admins');
      const data = await res.json();

      renderNumberList(
        document.getElementById('owner-list'),
        document.getElementById('owner-empty'),
        data.owners || [],
      );
      renderNumberList(
        document.getElementById('env-admin-list'),
        document.getElementById('env-admin-empty'),
        data.envAdmins || [],
      );

      accountLabels = {};
      accountSelect.innerHTML = '';
      for (const account of data.accounts || []) {
        accountLabels[account.id] = account.label;
        const opt = document.createElement('option');
        opt.value = account.id;
        opt.textContent = account.label;
        accountSelect.appendChild(opt);
      }

      renderDashboardAdmins(data.dashboardAdmins || []);

      const unconfigured = !data.supabaseConfigured;
      document.getElementById('unconfigured-state').classList.toggle('hidden', !unconfigured);
      document.getElementById('add-admin-btn').disabled = unconfigured;
    } catch (err) {
      if (err.message !== 'unauthenticated') adminsError.textContent = 'Could not load admins.';
    }
  }

  function renderDashboardAdmins(admins) {
    const list = document.getElementById('dashboard-admin-list');
    const empty = document.getElementById('dashboard-admin-empty');
    list.innerHTML = '';
    empty.classList.toggle('hidden', admins.length > 0);

    for (const admin of admins) {
      const card = document.createElement('div');
      card.className = 'card rule-card';

      const top = document.createElement('div');
      top.className = 'rule-card-top';
      const name = document.createElement('div');
      name.className = 'rule-name';
      name.textContent = admin.phoneNumber + (admin.label ? ' — ' + admin.label : '');
      top.appendChild(name);
      card.appendChild(top);

      const summary = document.createElement('div');
      summary.className = 'rule-summary';
      summary.textContent =
        (accountLabels[admin.accountId] || 'Unknown account') +
        ' · added ' +
        fmtDate(admin.createdAt);
      card.appendChild(summary);

      const actions = document.createElement('div');
      actions.className = 'rule-actions';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-sm btn-danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeAdmin(admin.id));
      actions.appendChild(removeBtn);
      card.appendChild(actions);

      list.appendChild(card);
    }
  }

  document.getElementById('add-admin-btn').addEventListener('click', async () => {
    adminsError.textContent = '';
    const accountId = accountSelect.value;
    const phoneNumber = document.getElementById('admin-phone').value.trim();
    const label = document.getElementById('admin-label').value.trim();
    if (!accountId || !phoneNumber) {
      adminsError.textContent = 'An account and phone number are required.';
      return;
    }
    try {
      const res = await api('/api/admins', {
        method: 'POST',
        body: JSON.stringify({ accountId, phoneNumber, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        adminsError.textContent = data.message || 'Could not add admin.';
        return;
      }
      document.getElementById('admin-phone').value = '';
      document.getElementById('admin-label').value = '';
      await load();
    } catch (err) {
      if (err.message !== 'unauthenticated')
        adminsError.textContent = 'Could not reach the server.';
    }
  });

  async function removeAdmin(id) {
    if (
      !window.confirm('Remove this admin? They will lose owner/admin command access immediately.')
    )
      return;
    try {
      await api('/api/admins/' + id, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (err.message !== 'unauthenticated') adminsError.textContent = 'Could not remove admin.';
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  load();
})();
