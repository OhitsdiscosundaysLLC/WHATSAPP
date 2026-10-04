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

  const accountSelect = document.getElementById('analytics-account');
  const rangeSelect = document.getElementById('analytics-range');
  const analyticsError = document.getElementById('analytics-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const content = document.getElementById('analytics-content');

  function renderTotals(totals) {
    const grid = document.getElementById('totals-grid');
    grid.innerHTML = '';
    for (const metric of totals) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.padding = '14px';
      const value = document.createElement('div');
      value.style.fontSize = '24px';
      value.style.fontWeight = '700';
      value.textContent = metric.value;
      const label = document.createElement('div');
      label.className = 'muted';
      label.style.fontSize = '12px';
      label.textContent = metric.label;
      card.appendChild(value);
      card.appendChild(label);
      grid.appendChild(card);
    }
  }

  function renderBarChart(containerId, series) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (!series.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No data in this range.';
      container.appendChild(empty);
      return;
    }
    const max = Math.max(1, ...series.map((d) => d.value));
    for (const day of series) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.marginBottom = '4px';

      const label = document.createElement('div');
      label.className = 'muted';
      label.style.fontSize = '11px';
      label.style.width = '80px';
      label.style.flexShrink = '0';
      label.textContent = day.date;

      const barTrack = document.createElement('div');
      barTrack.style.flex = '1';
      barTrack.style.background = 'var(--surface-raised)';
      barTrack.style.borderRadius = '4px';
      barTrack.style.height = '14px';
      barTrack.style.overflow = 'hidden';

      const bar = document.createElement('div');
      bar.style.height = '100%';
      bar.style.width = Math.round((day.value / max) * 100) + '%';
      bar.style.background = 'var(--accent)';
      barTrack.appendChild(bar);

      const value = document.createElement('div');
      value.style.fontSize = '12px';
      value.style.width = '32px';
      value.style.textAlign = 'right';
      value.textContent = day.value;

      row.appendChild(label);
      row.appendChild(barTrack);
      row.appendChild(value);
      container.appendChild(row);
    }
  }

  function renderTopGroups(topGroups) {
    const list = document.getElementById('top-groups-list');
    const empty = document.getElementById('top-groups-empty');
    list.innerHTML = '';
    empty.classList.toggle('hidden', topGroups.length > 0);
    const max = Math.max(1, ...topGroups.map((g) => g.messageCount));
    for (const group of topGroups) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.marginBottom = '6px';

      const label = document.createElement('div');
      label.style.width = '160px';
      label.style.flexShrink = '0';
      label.style.fontSize = '13px';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace = 'nowrap';
      label.textContent = group.subject;

      const barTrack = document.createElement('div');
      barTrack.style.flex = '1';
      barTrack.style.background = 'var(--surface-raised)';
      barTrack.style.borderRadius = '4px';
      barTrack.style.height = '14px';
      barTrack.style.overflow = 'hidden';
      const bar = document.createElement('div');
      bar.style.height = '100%';
      bar.style.width = Math.round((group.messageCount / max) * 100) + '%';
      bar.style.background = 'var(--accent)';
      barTrack.appendChild(bar);

      const value = document.createElement('div');
      value.style.fontSize = '12px';
      value.style.width = '32px';
      value.style.textAlign = 'right';
      value.textContent = group.messageCount;

      row.appendChild(label);
      row.appendChild(barTrack);
      row.appendChild(value);
      list.appendChild(row);
    }
  }

  function renderAiTokens(aiTokensUsed) {
    const el = document.getElementById('ai-tokens');
    el.innerHTML = '';
    const prompt = document.createElement('p');
    prompt.textContent = 'Prompt tokens: ' + aiTokensUsed.promptTokens;
    const completion = document.createElement('p');
    completion.textContent = 'Completion tokens: ' + aiTokensUsed.completionTokens;
    el.appendChild(prompt);
    el.appendChild(completion);
  }

  async function loadAnalytics() {
    analyticsError.textContent = '';
    const accountId = accountSelect.value;
    if (!accountId) return;
    try {
      const res = await api(
        '/api/accounts/' + accountId + '/analytics?rangeDays=' + rangeSelect.value,
      );
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        content.classList.add('hidden');
        return;
      }
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      content.classList.remove('hidden');
      renderTotals(data.totals);
      renderBarChart('messages-chart', data.messagesReceivedByDay);
      renderBarChart('rules-chart', data.rulesFiredByDay);
      renderTopGroups(data.topGroups);
      renderAiTokens(data.aiTokensUsed);
    } catch (err) {
      if (err.message !== 'unauthenticated')
        analyticsError.textContent = 'Could not load analytics.';
    }
  }

  accountSelect.addEventListener('change', loadAnalytics);
  rangeSelect.addEventListener('change', loadAnalytics);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  (async () => {
    try {
      const res = await api('/api/accounts');
      const data = await res.json();
      for (const account of data.accounts || []) {
        const opt = document.createElement('option');
        opt.value = account.id;
        opt.textContent = account.label;
        accountSelect.appendChild(opt);
      }
      await loadAnalytics();
    } catch (err) {
      if (err.message !== 'unauthenticated')
        analyticsError.textContent = 'Could not load accounts.';
    }
  })();
})();
