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

  // Emoji-categorized cards, not a raw log — "Owner Inbox" (product spec).
  const CATEGORY_ICON = {
    deleted_message: '🗑️',
    missed_call: '📞',
    moderation: '🛡️',
    ai_failure: '⚠️',
    disconnected: '🔌',
    automation_failure: '❌',
    rule_fired: '⚡',
  };

  const inboxList = document.getElementById('inbox-list');
  const inboxEmpty = document.getElementById('inbox-empty');
  const inboxError = document.getElementById('inbox-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const unreadOnlyFilter = document.getElementById('unread-only-filter');

  function renderItem(item) {
    const row = document.createElement('div');
    row.className = 'activity-item';
    if (!item.read) row.style.fontWeight = '600';
    row.style.cursor = 'pointer';

    const label = document.createElement('div');
    label.className = 'activity-event';
    label.textContent = (CATEGORY_ICON[item.category] || '•') + ' ' + item.title;

    const time = document.createElement('div');
    time.className = 'activity-time';
    time.textContent = fmtDate(item.createdAt);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.alignItems = 'center';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn btn-ghost btn-sm';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await api('/api/inbox/' + item.id + '/dismiss', { method: 'POST' });
        row.remove();
        inboxEmpty.classList.toggle('hidden', inboxList.children.length > 0);
      } catch (err) {
        if (err.message !== 'unauthenticated') inboxError.textContent = 'Could not dismiss.';
      }
    });

    row.addEventListener('click', async () => {
      if (item.read) return;
      item.read = true;
      row.style.fontWeight = 'normal';
      try {
        await api('/api/inbox/' + item.id + '/read', { method: 'POST' });
      } catch (err) {
        if (err.message !== 'unauthenticated') {
          item.read = false;
          row.style.fontWeight = '600';
        }
      }
    });

    actions.appendChild(time);
    actions.appendChild(dismissBtn);
    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  async function loadInbox() {
    inboxError.textContent = '';
    try {
      const unreadOnly = unreadOnlyFilter.checked ? 'true' : 'false';
      const res = await api('/api/inbox?limit=100&unreadOnly=' + unreadOnly);
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      const items = data.items || [];

      inboxList.innerHTML = '';
      inboxEmpty.classList.toggle('hidden', items.length > 0);
      for (const item of items) {
        inboxList.appendChild(renderItem(item));
      }
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        inboxError.textContent = 'Could not load inbox.';
      }
    }
  }

  unreadOnlyFilter.addEventListener('change', loadInbox);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadInbox();
})();
