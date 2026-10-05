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

  function pill(text, cls) {
    const span = document.createElement('span');
    span.className = 'status-pill ' + cls;
    span.innerHTML = '<span class="status-dot"></span><span></span>';
    span.querySelector('span:last-child').textContent = text;
    return span;
  }

  const RISK_PILL_CLASS = { low: 'status-neutral', medium: 'status-warn', high: 'status-error' };
  function riskPill(level) {
    return pill('Risk: ' + level, RISK_PILL_CLASS[level] || 'status-neutral');
  }

  const list = document.getElementById('group-list');
  const emptyState = document.getElementById('empty-state');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const groupsError = document.getElementById('groups-error');

  function renderGroups(groups) {
    list.innerHTML = '';
    emptyState.classList.toggle('hidden', groups.length > 0);

    for (const group of groups) {
      const row = document.createElement('a');
      row.className = 'card group-row';
      row.href = '/groups/' + group.id;

      const main = document.createElement('div');
      main.className = 'group-row-main';
      const subject = document.createElement('div');
      subject.className = 'group-subject';
      subject.textContent = group.subject || '(unnamed group)';
      const meta = document.createElement('div');
      meta.className = 'account-meta';
      meta.textContent =
        group.accountLabel + ' · ' + group.ruleCount + ' rule' + (group.ruleCount === 1 ? '' : 's');
      main.appendChild(subject);
      main.appendChild(meta);

      const pills = document.createElement('div');
      pills.className = 'group-row-pills';
      pills.appendChild(
        pill(
          'Bot ' + (group.botEnabled ? 'ON' : 'OFF'),
          group.botEnabled ? 'status-connected' : 'status-neutral',
        ),
      );
      pills.appendChild(
        pill(
          'Monitoring ' + (group.monitoringEnabled ? 'ON' : 'OFF'),
          group.monitoringEnabled ? 'status-connected' : 'status-neutral',
        ),
      );
      pills.appendChild(
        pill(
          'AI ' + (group.aiEnabled ? 'ON' : 'OFF'),
          group.aiEnabled ? 'status-connected' : 'status-neutral',
        ),
      );
      pills.appendChild(riskPill(group.riskLevel));

      row.appendChild(main);
      row.appendChild(pills);
      list.appendChild(row);
    }
  }

  async function loadGroups() {
    groupsError.textContent = '';
    try {
      const res = await api('/api/groups');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      renderGroups(data.groups || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        groupsError.textContent = 'Could not load groups.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadGroups();
})();
