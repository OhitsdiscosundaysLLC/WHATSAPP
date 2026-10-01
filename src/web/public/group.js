(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
  const groupId = document.querySelector('meta[name="group-id"]').content;

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

  const loadError = document.getElementById('load-error');
  const content = document.getElementById('group-content');
  const groupSubject = document.getElementById('group-subject');
  const groupMeta = document.getElementById('group-meta');

  // ---------- Settings ----------

  const FUNCTIONAL_TOGGLES = [
    {
      key: 'botEnabled',
      label: 'Bot',
      help: 'Master switch — rules only evaluate while this is on.',
    },
    {
      key: 'monitoringEnabled',
      label: 'Monitoring',
      help: 'Store normalized messages for this group (used for history/archiving features).',
    },
  ];

  const COMING_SOON_TOGGLES = [
    { key: 'aiEnabled', label: 'AI' },
    { key: 'autoReplyEnabled', label: 'Auto-reply' },
    { key: 'deletedMessageArchiveEnabled', label: 'Deleted-message archive' },
    { key: 'viewOnceHandlingEnabled', label: 'View-once handling' },
    { key: 'callHandlingEnabled', label: 'Call handling' },
    { key: 'moderationEnabled', label: 'Moderation' },
  ];

  const settingsToggles = document.getElementById('settings-toggles');
  const settingsError = document.getElementById('settings-error');

  function renderToggleRow(def, settings, functional) {
    const row = document.createElement('div');
    row.className = 'toggle-row';

    const label = document.createElement('div');
    label.className = 'toggle-label';
    const text = document.createElement('div');
    text.className = 'toggle-label-text';
    text.textContent = def.label;
    if (!functional) {
      const badge = document.createElement('span');
      badge.className = 'badge-soon';
      badge.textContent = 'Coming soon';
      text.appendChild(badge);
    }
    label.appendChild(text);
    if (def.help) {
      const help = document.createElement('div');
      help.className = 'muted';
      help.style.fontSize = '12px';
      help.textContent = def.help;
      label.appendChild(help);
    }

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(settings[def.key]);
    input.disabled = !functional;
    if (functional) {
      input.addEventListener('change', () => updateSetting(def.key, input.checked));
    }
    toggle.appendChild(input);
    const track = document.createElement('span');
    track.className = 'toggle-track';
    toggle.appendChild(track);
    const thumb = document.createElement('span');
    thumb.className = 'toggle-thumb';
    toggle.appendChild(thumb);

    row.appendChild(label);
    row.appendChild(toggle);
    return row;
  }

  function renderSettings(settings) {
    settingsToggles.innerHTML = '';
    for (const def of FUNCTIONAL_TOGGLES) {
      settingsToggles.appendChild(renderToggleRow(def, settings, true));
    }
    for (const def of COMING_SOON_TOGGLES) {
      settingsToggles.appendChild(renderToggleRow(def, settings, false));
    }
    document.getElementById('group-instructions').value = settings.customGroupInstructions || '';
  }

  async function updateSetting(key, value) {
    settingsError.textContent = '';
    try {
      const res = await api('/api/groups/' + groupId + '/settings', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      renderSettings(data.settings);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        settingsError.textContent = 'Could not save that setting — please try again.';
      }
    }
  }

  document.getElementById('save-instructions-btn').addEventListener('click', async () => {
    const value = document.getElementById('group-instructions').value;
    await updateSetting('customGroupInstructions', value);
  });

  // ---------- Rules ----------

  const ruleForm = document.getElementById('rule-form');
  const ruleList = document.getElementById('rule-list');
  const rulesEmpty = document.getElementById('rules-empty');
  const rulesError = document.getElementById('rules-error');

  function matchModeLabel(mode) {
    return (
      { contains: 'contains', exact: 'exactly matches', keyword_any: 'has the word' }[mode] || mode
    );
  }

  function renderRuleSummary(rule) {
    const q = rule.config.qualify;
    const phrasesText = q.phrases.map((p) => '"' + p + '"').join(', ');
    let actionText;
    if (rule.config.action.type === 'SEND_MESSAGE') {
      actionText = 'send "' + rule.config.action.message + '" to this group';
    } else if (rule.config.action.type === 'NOTIFY_OWNER') {
      actionText = 'notify the owner: "' + rule.config.action.message + '"';
    } else {
      actionText = 'log only (no message sent)';
    }
    const cooldown =
      rule.config.cooldownSeconds > 0 ? ', cooldown ' + rule.config.cooldownSeconds + 's' : '';
    return (
      'When ' +
      rule.config.threshold +
      ' distinct people reply to the same message where the reply ' +
      matchModeLabel(q.mode) +
      ' ' +
      phrasesText +
      ', ' +
      actionText +
      cooldown +
      '.'
    );
  }

  function renderRules(rules) {
    ruleList.innerHTML = '';
    rulesEmpty.classList.toggle('hidden', rules.length > 0);

    for (const rule of rules) {
      const card = document.createElement('div');
      card.className = 'card rule-card';

      const top = document.createElement('div');
      top.className = 'rule-card-top';
      const name = document.createElement('div');
      name.className = 'rule-name';
      name.textContent = rule.name;
      const pill = document.createElement('span');
      pill.className = 'status-pill ' + (rule.enabled ? 'status-connected' : 'status-neutral');
      pill.innerHTML = '<span class="status-dot"></span><span></span>';
      pill.querySelector('span:last-child').textContent = rule.enabled ? 'Enabled' : 'Disabled';
      top.appendChild(name);
      top.appendChild(pill);
      card.appendChild(top);

      const summary = document.createElement('div');
      summary.className = 'rule-summary';
      summary.textContent = renderRuleSummary(rule);
      card.appendChild(summary);

      const actions = document.createElement('div');
      actions.className = 'rule-actions';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-sm';
      toggleBtn.textContent = rule.enabled ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', () => setRuleEnabled(rule.id, !rule.enabled));
      actions.appendChild(toggleBtn);
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteRule(rule.id));
      actions.appendChild(deleteBtn);
      card.appendChild(actions);

      ruleList.appendChild(card);
    }
  }

  async function loadRules() {
    rulesError.textContent = '';
    try {
      const res = await api('/api/groups/' + groupId + '/rules');
      const data = await res.json();
      renderRules(data.rules || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') rulesError.textContent = 'Could not load rules.';
    }
  }

  async function setRuleEnabled(ruleId, enabled) {
    try {
      await api('/api/groups/' + groupId + '/rules/' + ruleId, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      await loadRules();
    } catch (err) {
      if (err.message !== 'unauthenticated') rulesError.textContent = 'Could not update the rule.';
    }
  }

  async function deleteRule(ruleId) {
    if (!window.confirm('Delete this rule? This cannot be undone.')) return;
    try {
      await api('/api/groups/' + groupId + '/rules/' + ruleId, { method: 'DELETE' });
      await loadRules();
    } catch (err) {
      if (err.message !== 'unauthenticated') rulesError.textContent = 'Could not delete the rule.';
    }
  }

  document.getElementById('new-rule-btn').addEventListener('click', () => {
    ruleForm.classList.remove('hidden');
  });
  document.getElementById('cancel-rule-btn').addEventListener('click', () => {
    ruleForm.classList.add('hidden');
  });
  document.getElementById('rule-action-type').addEventListener('change', (e) => {
    document
      .getElementById('rule-message-field')
      .classList.toggle('hidden', e.target.value === 'LOG_ONLY');
  });

  document.getElementById('save-rule-btn').addEventListener('click', async () => {
    rulesError.textContent = '';
    const phrases = document
      .getElementById('rule-phrases')
      .value.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const body = {
      name: document.getElementById('rule-name').value.trim(),
      phrases,
      matchMode: document.getElementById('rule-match-mode').value,
      threshold: document.getElementById('rule-threshold').value,
      cooldownSeconds: document.getElementById('rule-cooldown').value,
      actionType: document.getElementById('rule-action-type').value,
      message: document.getElementById('rule-message').value,
    };

    try {
      const res = await api('/api/groups/' + groupId + '/rules', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        rulesError.textContent = data.message || 'Could not create the rule.';
        return;
      }
      ruleForm.classList.add('hidden');
      document.getElementById('rule-name').value = '';
      document.getElementById('rule-phrases').value = '';
      document.getElementById('rule-threshold').value = '5';
      document.getElementById('rule-cooldown').value = '0';
      document.getElementById('rule-message').value = '';
      await loadRules();
    } catch (err) {
      if (err.message !== 'unauthenticated') rulesError.textContent = 'Could not reach the server.';
    }
  });

  // ---------- Activity ----------

  const activityList = document.getElementById('activity-list');
  const activityEmpty = document.getElementById('activity-empty');

  function describeEntry(entry, kind) {
    if (kind === 'event') return entry.eventType.replace(/\./g, ' ');
    return (
      'action: ' + entry.actionType.toLowerCase().replace(/_/g, ' ') + ' (' + entry.status + ')'
    );
  }

  async function loadActivity() {
    try {
      const res = await api('/api/activity?groupId=' + encodeURIComponent(groupId) + '&limit=25');
      if (!res.ok) return;
      const data = await res.json();
      const merged = [
        ...(data.events || []).map((e) => ({ ...e, kind: 'event' })),
        ...(data.actions || []).map((a) => ({ ...a, kind: 'action' })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      activityList.innerHTML = '';
      activityEmpty.classList.toggle('hidden', merged.length > 0);
      for (const entry of merged.slice(0, 25)) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        const label = document.createElement('div');
        label.className = 'activity-event';
        label.textContent = describeEntry(entry, entry.kind);
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
    } catch {
      // Non-critical — activity feed failing to load shouldn't block the rest of the page.
    }
  }

  // ---------- Init ----------

  async function init() {
    try {
      const res = await api('/api/groups/' + groupId);
      if (res.status === 404) {
        loadError.textContent = 'This group was not found.';
        return;
      }
      if (!res.ok) throw new Error('failed');
      const data = await res.json();

      groupSubject.textContent = data.group.subject || '(unnamed group)';
      groupMeta.textContent =
        data.group.accountLabel + ' · discovered ' + fmtDate(data.group.discoveredAt);

      renderSettings(data.settings);
      content.classList.remove('hidden');

      await loadRules();
      await loadActivity();
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        loadError.textContent = 'Could not load this group.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  init();
})();
