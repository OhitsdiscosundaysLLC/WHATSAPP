(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
  const groupId = document.querySelector('meta[name="group-id"]').content;
  let accountId = null;

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

  // ---------- Section tabs ----------

  document.querySelectorAll('[data-section-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-section-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-section-tab');
      document.querySelectorAll('.section-tab').forEach((section) => {
        section.classList.toggle('hidden', section.getAttribute('data-section') !== target);
      });
    });
  });

  // ---------- Generic toggle renderer ----------

  function renderToggleRow(def, settings, onChange) {
    const row = document.createElement('div');
    row.className = 'toggle-row';

    const label = document.createElement('div');
    label.className = 'toggle-label';
    const text = document.createElement('div');
    text.className = 'toggle-label-text';
    text.textContent = def.label;
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
    input.addEventListener('change', () => onChange(def.key, input.checked));
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

  async function patchSettings(patch) {
    const res = await api('/api/groups/' + groupId + '/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    currentSettings = data.settings;
    return data.settings;
  }

  let currentSettings = null;

  // ---------- General ----------

  const GENERAL_TOGGLES = [
    {
      key: 'botEnabled',
      label: 'Bot',
      help: 'Master switch — rules only evaluate while this is on.',
    },
    {
      key: 'monitoringEnabled',
      label: 'Monitoring',
      help: 'Store normalized messages for this group — required for deleted-message/view-once archiving.',
    },
  ];
  const generalToggles = document.getElementById('general-toggles');
  const settingsError = document.getElementById('settings-error');

  function renderGeneral(settings) {
    generalToggles.innerHTML = '';
    for (const def of GENERAL_TOGGLES) {
      generalToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          settingsError.textContent = '';
          try {
            renderGeneral(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
          }
        }),
      );
    }
    document.getElementById('group-instructions').value = settings.customGroupInstructions || '';
  }

  document.getElementById('save-instructions-btn').addEventListener('click', async () => {
    settingsError.textContent = '';
    try {
      renderGeneral(
        await patchSettings({
          customGroupInstructions: document.getElementById('group-instructions').value,
        }),
      );
    } catch (err) {
      if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
    }
  });

  // ---------- AI ----------

  const AI_TOGGLES = [
    { key: 'aiEnabled', label: 'AI', help: 'Master AI switch for this group.' },
    {
      key: 'autoReplyEnabled',
      label: 'Auto Reply',
      help: 'Allows auto-reply rules to fire (deterministic or AI).',
    },
    {
      key: 'aiAutoReplyEnabled',
      label: 'AI Auto Reply',
      help: 'Permits AI-generated auto-replies specifically — also requires AI and Auto Reply above.',
    },
    {
      key: 'aiSemanticClassificationEnabled',
      label: 'AI Semantic Classification',
      help: 'Permits rules to use AI to decide whether a message qualifies.',
    },
  ];
  const aiToggles = document.getElementById('ai-toggles');
  const aiError = document.getElementById('ai-error');

  function renderAi(settings) {
    aiToggles.innerHTML = '';
    for (const def of AI_TOGGLES) {
      aiToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          aiError.textContent = '';
          try {
            renderAi(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') aiError.textContent = 'Could not save.';
          }
        }),
      );
    }
    document.getElementById('ai-cooldown').value = settings.aiCooldownSeconds ?? 0;
    document.getElementById('ai-max-per-hour').value = settings.aiMaxResponsesPerHour ?? '';
    document.getElementById('ai-instructions').value = settings.customAiInstructions || '';
  }

  document.getElementById('save-ai-btn').addEventListener('click', async () => {
    aiError.textContent = '';
    const maxPerHourRaw = document.getElementById('ai-max-per-hour').value.trim();
    try {
      renderAi(
        await patchSettings({
          aiCooldownSeconds: Number(document.getElementById('ai-cooldown').value || 0),
          aiMaxResponsesPerHour: maxPerHourRaw === '' ? null : Number(maxPerHourRaw),
          customAiInstructions: document.getElementById('ai-instructions').value,
        }),
      );
    } catch (err) {
      if (err.message !== 'unauthenticated') aiError.textContent = 'Could not save.';
    }
  });

  // ---------- Moderation ----------

  const MODERATION_TOGGLES = [
    { key: 'moderationEnabled', label: 'Moderation', help: 'Allows moderation rules to evaluate.' },
    {
      key: 'moderationDestructiveActionsEnabled',
      label: 'Destructive actions (delete / remove)',
      help: 'Without this, DELETE_MESSAGE and REMOVE_USER actions are always skipped, never executed.',
    },
  ];
  const moderationToggles = document.getElementById('moderation-toggles');
  const moderationError = document.getElementById('moderation-error');

  function renderModeration(settings) {
    moderationToggles.innerHTML = '';
    for (const def of MODERATION_TOGGLES) {
      moderationToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          moderationError.textContent = '';
          try {
            renderModeration(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') moderationError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  // ---------- Archive ----------

  const ARCHIVE_TOGGLES = [
    { key: 'deletedMessageArchiveEnabled', label: 'Deleted-message archive' },
  ];
  const VIEWONCE_TOGGLES = [{ key: 'viewOnceHandlingEnabled', label: 'View-once handling' }];
  const archiveToggles = document.getElementById('archive-toggles');
  const viewonceToggles = document.getElementById('viewonce-toggles');
  const archiveError = document.getElementById('archive-error');

  function renderArchive(settings) {
    archiveToggles.innerHTML = '';
    for (const def of ARCHIVE_TOGGLES) {
      archiveToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          archiveError.textContent = '';
          try {
            renderArchive(await patchSettings({ [key]: value }));
            renderViewOnce(currentSettings);
          } catch (err) {
            if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
          }
        }),
      );
    }
    document.getElementById('retention-days').value = settings.deletedMessageRetentionDays || '';
  }

  function renderViewOnce(settings) {
    viewonceToggles.innerHTML = '';
    for (const def of VIEWONCE_TOGGLES) {
      viewonceToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          archiveError.textContent = '';
          try {
            renderViewOnce(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  document.getElementById('save-archive-btn').addEventListener('click', async () => {
    archiveError.textContent = '';
    const raw = document.getElementById('retention-days').value;
    try {
      renderArchive(
        await patchSettings({ deletedMessageRetentionDays: raw === '' ? null : Number(raw) }),
      );
    } catch (err) {
      if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
    }
  });

  async function loadDeletedMessages() {
    const list = document.getElementById('deleted-list');
    const empty = document.getElementById('deleted-empty');
    try {
      const res = await api('/api/groups/' + groupId + '/deleted-messages');
      if (!res.ok) return;
      const data = await res.json();
      const messages = data.messages || [];
      list.innerHTML = '';
      empty.classList.toggle('hidden', messages.length > 0);
      for (const m of messages) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        const label = document.createElement('div');
        label.className = 'activity-event';
        label.textContent = m.senderJid + ' — ' + m.messageType;
        const detail = document.createElement('div');
        detail.className = 'activity-detail';
        detail.textContent = m.textContent || '(no archived text)';
        const time = document.createElement('div');
        time.className = 'activity-time';
        time.textContent = 'deleted ' + fmtDate(m.deletedAt);
        row.appendChild(label);
        row.appendChild(detail);
        row.appendChild(time);
        list.appendChild(row);
      }
    } catch {
      // non-critical
    }
  }

  async function loadMediaArchive() {
    const list = document.getElementById('media-list');
    const empty = document.getElementById('media-empty');
    try {
      const res = await api('/api/groups/' + groupId + '/media-archive');
      if (!res.ok) return;
      const data = await res.json();
      const items = data.media || [];
      list.innerHTML = '';
      empty.classList.toggle('hidden', items.length > 0);
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        const label = document.createElement('div');
        label.className = 'activity-event';
        label.textContent =
          (item.isViewOnce ? 'View-once' : 'Media') +
          ' from ' +
          item.senderJid +
          ' (' +
          item.mimeType +
          ')';
        const detail = document.createElement('div');
        detail.className = 'activity-detail';
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-sm';
        viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', async () => {
          const urlRes = await api('/api/groups/' + groupId + '/media-archive/' + item.id + '/url');
          if (!urlRes.ok) return;
          const urlData = await urlRes.json();
          window.open(urlData.url, '_blank', 'noopener');
        });
        detail.appendChild(viewBtn);
        const time = document.createElement('div');
        time.className = 'activity-time';
        time.textContent = fmtDate(item.createdAt);
        row.appendChild(label);
        row.appendChild(detail);
        row.appendChild(time);
        list.appendChild(row);
      }
    } catch {
      // non-critical
    }
  }

  // ---------- Calls (account-level) ----------

  const callsError = document.getElementById('calls-error');

  function updateCallMessageVisibility() {
    const action = document.getElementById('call-response-action').value;
    document
      .getElementById('call-message-field')
      .classList.toggle('hidden', action !== 'SEND_MESSAGE_AFTER');
  }
  document
    .getElementById('call-response-action')
    .addEventListener('change', updateCallMessageVisibility);

  async function loadCallSettings() {
    if (!accountId) return;
    try {
      const res = await api('/api/accounts/' + accountId + '/call-settings');
      if (!res.ok) {
        if (res.status === 503)
          callsError.textContent = 'Call handling requires Supabase to be configured.';
        return;
      }
      const data = await res.json();
      document.getElementById('call-handling-enabled').checked = Boolean(
        data.settings.callHandlingEnabled,
      );
      document.getElementById('call-response-action').value = data.settings.callResponseAction;
      document.getElementById('call-response-message').value =
        data.settings.callResponseMessage || '';
      updateCallMessageVisibility();
    } catch (err) {
      if (err.message !== 'unauthenticated')
        callsError.textContent = 'Could not load call settings.';
    }
  }

  document.getElementById('save-calls-btn').addEventListener('click', async () => {
    callsError.textContent = '';
    try {
      const res = await api('/api/accounts/' + accountId + '/call-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          callHandlingEnabled: document.getElementById('call-handling-enabled').checked,
          callResponseAction: document.getElementById('call-response-action').value,
          callResponseMessage: document.getElementById('call-response-message').value,
        }),
      });
      if (!res.ok) throw new Error('failed');
    } catch (err) {
      if (err.message !== 'unauthenticated')
        callsError.textContent = 'Could not save call settings.';
    }
  });

  // ---------- Rules ----------

  const ruleForm = document.getElementById('rule-form');
  const ruleList = document.getElementById('rule-list');
  const rulesEmpty = document.getElementById('rules-empty');
  const rulesError = document.getElementById('rules-error');

  const ACTIONS_BY_TRIGGER = {
    response_threshold: [
      ['SEND_MESSAGE', 'Send a message to this group'],
      ['NOTIFY_OWNER', 'Notify the owner (not the group)'],
      ['LOG_ONLY', "Log only — don't send anything"],
    ],
    auto_reply: [
      ['SEND_MESSAGE', 'Send a fixed message'],
      ['AI_REPLY', 'Generate the reply with AI'],
    ],
    moderation: [
      ['LOG_ONLY', 'Log only'],
      ['WARN', 'Warn in the group'],
      ['NOTIFY_OWNER', 'Notify the owner'],
      ['DELETE_MESSAGE', 'Delete the message (requires destructive actions enabled)'],
      ['REMOVE_USER', 'Remove the participant (requires destructive actions enabled)'],
    ],
  };

  function updateRuleFormFields() {
    const triggerType = document.getElementById('rule-trigger-type').value;
    document
      .getElementById('rule-fields-phrases')
      .classList.toggle(
        'hidden',
        triggerType === 'moderation' ||
          (triggerType === 'auto_reply' &&
            document.getElementById('rule-classifier').value === 'ai'),
      );
    document
      .getElementById('rule-fields-threshold')
      .classList.toggle('hidden', triggerType !== 'response_threshold');
    document
      .getElementById('rule-fields-autoreply')
      .classList.toggle('hidden', triggerType !== 'auto_reply');
    document
      .getElementById('rule-fields-moderation')
      .classList.toggle('hidden', triggerType !== 'moderation');
    document
      .getElementById('rule-ai-instructions-field')
      .classList.toggle(
        'hidden',
        !(
          triggerType === 'auto_reply' && document.getElementById('rule-classifier').value === 'ai'
        ),
      );

    const actionSelect = document.getElementById('rule-action-type');
    actionSelect.innerHTML = '';
    for (const [value, label] of ACTIONS_BY_TRIGGER[triggerType]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      actionSelect.appendChild(opt);
    }
    updateRuleMessageVisibility();
  }

  function updateRuleMessageVisibility() {
    const action = document.getElementById('rule-action-type').value;
    document
      .getElementById('rule-message-field')
      .classList.toggle(
        'hidden',
        action === 'LOG_ONLY' ||
          action === 'AI_REPLY' ||
          action === 'DELETE_MESSAGE' ||
          action === 'REMOVE_USER',
      );
  }

  document.getElementById('rule-trigger-type').addEventListener('change', updateRuleFormFields);
  document.getElementById('rule-classifier').addEventListener('change', updateRuleFormFields);
  document
    .getElementById('rule-action-type')
    .addEventListener('change', updateRuleMessageVisibility);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rule-action-type') updateRuleMessageVisibility();
  });

  function matchModeLabel(mode) {
    return (
      { contains: 'contains', exact: 'exactly matches', keyword_any: 'has the word' }[mode] || mode
    );
  }

  function actionText(action) {
    if (action.type === 'SEND_MESSAGE') return 'send "' + action.message + '"';
    if (action.type === 'NOTIFY_OWNER') return 'notify the owner: "' + action.message + '"';
    if (action.type === 'AI_REPLY') return 'reply with an AI-generated message';
    if (action.type === 'WARN') return 'warn in the group: "' + action.message + '"';
    if (action.type === 'DELETE_MESSAGE') return 'delete the message';
    if (action.type === 'REMOVE_USER') return 'remove the participant';
    return 'log only';
  }

  function renderRuleSummary(rule) {
    const cfg = rule.config;
    const cooldown = cfg.cooldownSeconds > 0 ? ', cooldown ' + cfg.cooldownSeconds + 's' : '';

    if (rule.triggerType === 'response_threshold') {
      const q = cfg.qualify;
      const phrasesText = q.phrases.map((p) => '"' + p + '"').join(', ');
      return (
        'When ' +
        cfg.threshold +
        ' distinct people reply to the same message where the reply ' +
        matchModeLabel(q.mode) +
        ' ' +
        phrasesText +
        ', ' +
        actionText(cfg.action) +
        cooldown +
        '.'
      );
    }
    if (rule.triggerType === 'auto_reply') {
      const qualifyText =
        cfg.qualify.classifier === 'ai'
          ? 'AI decides the message ' + cfg.qualify.aiInstructions
          : 'the message ' +
            matchModeLabel(cfg.qualify.mode) +
            ' ' +
            cfg.qualify.phrases.map((p) => '"' + p + '"').join(', ');
      return 'When ' + qualifyText + ', ' + actionText(cfg.action) + cooldown + '.';
    }
    if (rule.triggerType === 'moderation') {
      const parts = [];
      if (cfg.qualify.bannedPhrases.length) parts.push('contains a banned phrase');
      if (cfg.qualify.spamRepeatThreshold > 0) {
        parts.push(
          cfg.qualify.spamRepeatThreshold +
            '+ messages in ' +
            cfg.qualify.spamWindowSeconds +
            's from the same sender',
        );
      }
      if (cfg.qualify.detectLinks) parts.push('contains a link');
      return (
        'When a message ' +
        (parts.join(' or ') || '(nothing configured)') +
        ', ' +
        actionText(cfg.action) +
        cooldown +
        '.'
      );
    }
    return '(unknown rule type)';
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
      name.textContent = rule.name + '  ·  ' + rule.triggerType;
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
    updateRuleFormFields();
  });
  document.getElementById('cancel-rule-btn').addEventListener('click', () => {
    ruleForm.classList.add('hidden');
  });

  document.getElementById('save-rule-btn').addEventListener('click', async () => {
    rulesError.textContent = '';
    const triggerType = document.getElementById('rule-trigger-type').value;
    const phrases = document
      .getElementById('rule-phrases')
      .value.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const bannedPhrases = document
      .getElementById('rule-banned-phrases')
      .value.split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const body = {
      name: document.getElementById('rule-name').value.trim(),
      triggerType,
      phrases,
      matchMode: document.getElementById('rule-match-mode').value,
      threshold: document.getElementById('rule-threshold').value,
      classifier: document.getElementById('rule-classifier').value,
      aiInstructions: document.getElementById('rule-ai-instructions').value,
      bannedPhrases,
      spamRepeatThreshold: document.getElementById('rule-spam-threshold').value,
      spamWindowSeconds: document.getElementById('rule-spam-window').value,
      detectLinks: document.getElementById('rule-detect-links').checked,
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
      document.getElementById('rule-banned-phrases').value = '';
      document.getElementById('rule-ai-instructions').value = '';
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

      accountId = data.group.accountId;
      groupSubject.textContent = data.group.subject || '(unnamed group)';
      groupMeta.textContent =
        data.group.accountLabel + ' · discovered ' + fmtDate(data.group.discoveredAt);

      currentSettings = data.settings;
      renderGeneral(data.settings);
      renderAi(data.settings);
      renderModeration(data.settings);
      renderArchive(data.settings);
      renderViewOnce(data.settings);
      content.classList.remove('hidden');

      await Promise.all([
        loadRules(),
        loadActivity(),
        loadDeletedMessages(),
        loadMediaArchive(),
        loadCallSettings(),
      ]);
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
