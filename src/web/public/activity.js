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

  function describeEntry(entry) {
    if (entry.kind === 'event') return entry.eventType.replace(/\./g, ' ');
    return (
      'action: ' + entry.actionType.toLowerCase().replace(/_/g, ' ') + ' (' + entry.status + ')'
    );
  }

  const activityList = document.getElementById('activity-list');
  const activityEmpty = document.getElementById('activity-empty');
  const activityError = document.getElementById('activity-error');
  const unconfiguredState = document.getElementById('unconfigured-state');

  async function loadActivity() {
    activityError.textContent = '';
    try {
      const res = await api('/api/activity?limit=100');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      const merged = [
        ...(data.events || []).map((e) => ({ ...e, kind: 'event' })),
        ...(data.actions || []).map((a) => ({ ...a, kind: 'action' })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      activityList.innerHTML = '';
      activityEmpty.classList.toggle('hidden', merged.length > 0);
      for (const entry of merged.slice(0, 100)) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        const label = document.createElement('div');
        label.className = 'activity-event';
        label.textContent = describeEntry(entry);
        const detail = document.createElement('div');
        detail.className = 'activity-detail';
        detail.textContent = entry.detail ? JSON.stringify(entry.detail) : '';
        const time = document.createElement('div');
        time.className = 'activity-time';
        time.textContent = fmtDate(entry.createdAt);
        row.appendChild(label);
        row.appendChild(detail);
        row.appendChild(time);
        activityList.appendChild(row);
      }
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        activityError.textContent = 'Could not load activity.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadActivity();
})();
