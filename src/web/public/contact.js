(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
  const contactId = document.querySelector('meta[name="contact-id"]').content;

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

  function flashSaved(button) {
    const original = button.textContent;
    button.textContent = 'Saved ✓';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  const loadError = document.getElementById('load-error');
  const content = document.getElementById('contact-content');
  const contactSubject = document.getElementById('contact-subject');
  const contactMeta = document.getElementById('contact-meta');

  // ---------- Risk label + Bot Capability Preview ----------

  const RISK_PILL_CLASS = { low: 'status-neutral', medium: 'status-warn', high: 'status-error' };

  function renderCapability(risk, capabilitySummary) {
    const riskPillEl = document.getElementById('risk-pill');
    riskPillEl.innerHTML = '';
    if (risk) {
      const pill = document.createElement('span');
      pill.className = 'status-pill ' + (RISK_PILL_CLASS[risk.level] || 'status-neutral');
      pill.title = risk.reasons.join(' ');
      pill.innerHTML = '<span class="status-dot"></span><span></span>';
      pill.querySelector('span:last-child').textContent = 'Risk: ' + risk.level;
      riskPillEl.appendChild(pill);
    }

    const list = document.getElementById('capability-list');
    list.innerHTML = '';
    for (const line of capabilitySummary || []) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
  }

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
    const res = await api('/api/contacts/' + contactId + '/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    currentSettings = data.settings;
    renderCapability(data.risk, data.capabilitySummary);
    return data.settings;
  }

  let currentSettings = null;
  let currentContact = null;

  // ---------- Block / display name ----------

  const blockedToggle = document.getElementById('blocked-toggle');
  blockedToggle.addEventListener('change', async () => {
    try {
      const res = await api('/api/contacts/' + contactId, {
        method: 'PATCH',
        body: JSON.stringify({ blocked: blockedToggle.checked }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      currentContact = data.contact;
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        blockedToggle.checked = !blockedToggle.checked; // revert on failure
        loadError.textContent = 'Could not update blocked status.';
      }
    }
  });

  document.getElementById('save-name-btn').addEventListener('click', async (event) => {
    try {
      const res = await api('/api/contacts/' + contactId, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: document.getElementById('display-name').value }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      currentContact = data.contact;
      contactSubject.textContent = currentContact.displayName || currentContact.whatsappJid;
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') loadError.textContent = 'Could not save name.';
    }
  });

  // ---------- General ----------

  const GENERAL_TOGGLES = [
    {
      key: 'privateMonitoringEnabled',
      label: 'Monitoring',
      help: 'Store normalized messages for this chat — required for the deleted-message archive.',
    },
    {
      key: 'dryRunEnabled',
      label: 'Dry Run',
      help: 'Evaluate auto-reply rules normally, but log "would have sent X" instead of actually sending. See Activity for what it would have done.',
    },
    { key: 'vip', label: 'VIP', help: 'Label only — never changes any automation behavior.' },
    {
      key: 'neverAutoReply',
      label: 'Never Auto Reply',
      help: 'Overrides every auto-reply rule for this contact, even if one would otherwise match.',
    },
    {
      key: 'approvalRequired',
      label: 'Require owner approval before sending',
      help: 'Auto-reply rules propose their message instead of sending it — see the Approvals page.',
    },
  ];
  const generalToggles = document.getElementById('general-toggles');
  const settingsError = document.getElementById('settings-error');

  function renderGeneralToggles(settings) {
    generalToggles.innerHTML = '';
    for (const def of GENERAL_TOGGLES) {
      generalToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          settingsError.textContent = '';
          try {
            renderGeneralToggles(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  function renderGeneral(settings) {
    renderGeneralToggles(settings);
    document.getElementById('contact-instructions').value = settings.customInstructions || '';
    document.getElementById('default-cooldown-seconds').value =
      settings.defaultCooldownSeconds || 0;
    document.getElementById('owner-notes').value = settings.ownerNotes || '';
    renderQuietHours(settings);
    renderTakeoverStatus(settings);
  }

  document.getElementById('save-default-cooldown-btn').addEventListener('click', async (event) => {
    settingsError.textContent = '';
    try {
      renderGeneral(
        await patchSettings({
          defaultCooldownSeconds:
            Number(document.getElementById('default-cooldown-seconds').value) || 0,
        }),
      );
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
    }
  });

  document.getElementById('save-owner-notes-btn').addEventListener('click', async (event) => {
    settingsError.textContent = '';
    try {
      renderGeneral(
        await patchSettings({ ownerNotes: document.getElementById('owner-notes').value }),
      );
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
    }
  });

  // ---------- Quiet Hours ----------

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const quietHoursError = document.getElementById('quiet-hours-error');

  function minutesToTimeInput(minutes) {
    if (minutes == null) return '';
    const h = Math.floor(minutes / 60)
      .toString()
      .padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return h + ':' + m;
  }

  function timeInputToMinutes(value) {
    if (!value) return undefined;
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  }

  function renderQuietHours(settings) {
    document.getElementById('quiet-hours-enabled').checked = Boolean(settings.quietHoursEnabled);
    document.getElementById('quiet-hours-timezone').value = settings.quietHoursTimezone || '';
    document.getElementById('quiet-hours-start').value = minutesToTimeInput(
      settings.quietHoursStartMinutes,
    );
    document.getElementById('quiet-hours-end').value = minutesToTimeInput(
      settings.quietHoursEndMinutes,
    );
    const daysContainer = document.getElementById('quiet-hours-days');
    daysContainer.innerHTML = '';
    const selectedDays = new Set(settings.quietHoursDays || []);
    DAY_LABELS.forEach((label, index) => {
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '4px';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selectedDays.has(index);
      input.dataset.day = String(index);
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(label));
      daysContainer.appendChild(wrap);
    });
  }

  document.getElementById('save-quiet-hours-btn').addEventListener('click', async (event) => {
    quietHoursError.textContent = '';
    try {
      const days = Array.from(
        document.querySelectorAll('#quiet-hours-days input[type="checkbox"]:checked'),
      ).map((el) => Number(el.dataset.day));
      renderGeneral(
        await patchSettings({
          quietHoursEnabled: document.getElementById('quiet-hours-enabled').checked,
          quietHoursTimezone: document.getElementById('quiet-hours-timezone').value || null,
          quietHoursDays: days,
          quietHoursStartMinutes: timeInputToMinutes(
            document.getElementById('quiet-hours-start').value,
          ),
          quietHoursEndMinutes: timeInputToMinutes(
            document.getElementById('quiet-hours-end').value,
          ),
        }),
      );
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') quietHoursError.textContent = 'Could not save.';
    }
  });

  // ---------- Human Takeover ----------

  const takeoverError = document.getElementById('takeover-error');
  const takeoverStatus = document.getElementById('takeover-status');

  function renderTakeoverStatus(settings) {
    if (settings.humanTakeoverUntil && new Date(settings.humanTakeoverUntil) > new Date()) {
      takeoverStatus.textContent =
        'HUMAN TAKEOVER ACTIVE until ' + fmtDate(settings.humanTakeoverUntil);
      takeoverStatus.style.color = 'var(--accent, #d97706)';
    } else {
      takeoverStatus.textContent = 'Automation active (no takeover in effect).';
      takeoverStatus.style.color = '';
    }
  }

  async function startTakeover(durationMinutes) {
    takeoverError.textContent = '';
    try {
      const res = await api('/api/contacts/' + contactId + '/human-takeover', {
        method: 'POST',
        body: JSON.stringify({ durationMinutes }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      currentSettings = data.settings;
      renderGeneral(data.settings);
      renderCapability(data.risk, data.capabilitySummary);
    } catch (err) {
      if (err.message !== 'unauthenticated')
        takeoverError.textContent = 'Could not start takeover.';
    }
  }

  document.querySelectorAll('[data-takeover-minutes]').forEach((btn) => {
    btn.addEventListener('click', () => startTakeover(Number(btn.dataset.takeoverMinutes)));
  });

  document.getElementById('takeover-custom-btn').addEventListener('click', () => {
    const minutes = Number(document.getElementById('takeover-custom-minutes').value);
    if (minutes > 0) startTakeover(minutes);
  });

  document.getElementById('takeover-resume-btn').addEventListener('click', async () => {
    takeoverError.textContent = '';
    try {
      const res = await api('/api/contacts/' + contactId + '/human-takeover', {
        method: 'POST',
        body: JSON.stringify({ resume: true }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      currentSettings = data.settings;
      renderGeneral(data.settings);
      renderCapability(data.risk, data.capabilitySummary);
    } catch (err) {
      if (err.message !== 'unauthenticated') takeoverError.textContent = 'Could not resume.';
    }
  });

  document.getElementById('save-instructions-btn').addEventListener('click', async (event) => {
    settingsError.textContent = '';
    try {
      renderGeneral(
        await patchSettings({
          customInstructions: document.getElementById('contact-instructions').value,
        }),
      );
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') settingsError.textContent = 'Could not save.';
    }
  });

  // ---------- AI ----------

  const AI_TOGGLES = [
    { key: 'privateAiEnabled', label: 'AI', help: 'Master AI switch for this contact.' },
    {
      key: 'privateAutoReplyEnabled',
      label: 'Auto Reply',
      help: 'Allows auto-reply rules to fire (deterministic or AI).',
    },
    {
      key: 'privateAiAutoReplyEnabled',
      label: 'AI Auto Reply',
      help: 'Permits AI-generated auto-replies specifically — also requires AI and Auto Reply above.',
    },
    {
      key: 'privateAiSemanticClassificationEnabled',
      label: 'AI Semantic Classification',
      help: 'Permits rules to use AI to decide whether a message qualifies.',
    },
  ];
  const aiToggles = document.getElementById('ai-toggles');
  const aiError = document.getElementById('ai-error');

  function renderAiToggles(settings) {
    aiToggles.innerHTML = '';
    for (const def of AI_TOGGLES) {
      aiToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          aiError.textContent = '';
          try {
            renderAiToggles(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') aiError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  function renderAi(settings) {
    renderAiToggles(settings);
    document.getElementById('ai-cooldown').value = settings.aiCooldownSeconds ?? 0;
    document.getElementById('ai-max-per-hour').value = settings.aiMaxResponsesPerHour ?? '';
    document.getElementById('ai-instructions').value = settings.customAiInstructions || '';
  }

  document.getElementById('save-ai-btn').addEventListener('click', async (event) => {
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
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') aiError.textContent = 'Could not save.';
    }
  });

  // ---------- Rule Simulator ----------

  const simError = document.getElementById('sim-error');
  const simResults = document.getElementById('sim-results');

  const MATCHED_LABEL = {
    yes: { text: 'MATCHED', cls: 'status-connected' },
    no: { text: 'NOT MATCHED', cls: 'status-neutral' },
    ai_not_simulated: { text: 'AI — NOT SIMULATED', cls: 'status-neutral' },
  };

  function renderSimResults(outcome) {
    simResults.innerHTML = '';

    if (outcome.notes && outcome.notes.length) {
      const notes = document.createElement('div');
      notes.className = 'card';
      notes.style.padding = '12px 16px';
      notes.style.marginBottom = '14px';
      notes.style.fontSize = '13px';
      for (const note of outcome.notes) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.style.margin = '4px 0';
        p.textContent = 'ℹ️ ' + note;
        notes.appendChild(p);
      }
      simResults.appendChild(notes);
    }

    if (!outcome.rules.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No enabled rules to evaluate.';
      simResults.appendChild(empty);
      return;
    }

    for (const rule of outcome.rules) {
      const card = document.createElement('div');
      card.className = 'card rule-card';
      card.style.marginBottom = '10px';
      card.style.padding = '14px';

      const top = document.createElement('div');
      top.className = 'rule-card-top';
      const name = document.createElement('div');
      name.className = 'rule-name';
      name.textContent = rule.ruleName + '  ·  ' + rule.triggerType;
      const pill = document.createElement('span');
      const label = MATCHED_LABEL[rule.matched] || MATCHED_LABEL.no;
      pill.className = 'status-pill ' + label.cls;
      pill.innerHTML = '<span class="status-dot"></span><span></span>';
      pill.querySelector('span:last-child').textContent = label.text;
      top.appendChild(name);
      top.appendChild(pill);
      card.appendChild(top);

      const reason = document.createElement('div');
      reason.className = 'rule-summary';
      reason.textContent = rule.reason;
      card.appendChild(reason);

      if (rule.wouldHaveActed) {
        const acted = document.createElement('div');
        acted.className = 'rule-summary';
        acted.style.fontWeight = '600';
        acted.textContent = 'Would do: ' + rule.wouldHaveActed;
        card.appendChild(acted);
      }

      simResults.appendChild(card);
    }
  }

  document.getElementById('run-sim-btn').addEventListener('click', async (event) => {
    simError.textContent = '';
    const text = document.getElementById('sim-text').value;
    if (!text.trim()) {
      simError.textContent = 'Message text is required.';
      return;
    }
    const senderJid = (currentContact && currentContact.whatsappJid) || '';

    try {
      const res = await api('/api/contacts/' + contactId + '/simulate', {
        method: 'POST',
        body: JSON.stringify({ senderJid, text }),
      });
      const data = await res.json();
      if (!res.ok) {
        simError.textContent = data.message || 'Could not run the simulation.';
        return;
      }
      renderSimResults(data);
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') simError.textContent = 'Could not reach the server.';
    }
  });

  // ---------- Archive ----------

  const ARCHIVE_TOGGLES = [
    { key: 'privateDeletedMessageArchiveEnabled', label: 'Deleted-message archive' },
  ];
  const MEDIA_ARCHIVE_TOGGLES = [
    {
      key: 'mediaArchiveEnabled',
      label: 'General media archive',
      help: 'Archives ordinary (non-view-once) images, videos, audio, documents, and stickers in this chat.',
    },
  ];
  const archiveToggles = document.getElementById('archive-toggles');
  const mediaArchiveToggles = document.getElementById('media-archive-toggles');
  const archiveError = document.getElementById('archive-error');

  function renderArchiveToggles(settings) {
    archiveToggles.innerHTML = '';
    for (const def of ARCHIVE_TOGGLES) {
      archiveToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          archiveError.textContent = '';
          try {
            renderArchiveToggles(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  function renderMediaArchiveToggles(settings) {
    mediaArchiveToggles.innerHTML = '';
    for (const def of MEDIA_ARCHIVE_TOGGLES) {
      mediaArchiveToggles.appendChild(
        renderToggleRow(def, settings, async (key, value) => {
          archiveError.textContent = '';
          try {
            renderMediaArchiveToggles(await patchSettings({ [key]: value }));
          } catch (err) {
            if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
          }
        }),
      );
    }
  }

  function renderArchive(settings) {
    renderArchiveToggles(settings);
    document.getElementById('retention-days').value = settings.deletedMessageRetentionDays || '';
    document.getElementById('alert-mode').value =
      settings.deletedMessageAlertMode || 'archive_only';
  }

  document.getElementById('save-archive-btn').addEventListener('click', async (event) => {
    archiveError.textContent = '';
    const raw = document.getElementById('retention-days').value;
    const alertMode = document.getElementById('alert-mode').value;
    try {
      renderArchive(
        await patchSettings({
          deletedMessageRetentionDays: raw === '' ? null : Number(raw),
          deletedMessageAlertMode: alertMode,
        }),
      );
      flashSaved(event.currentTarget);
    } catch (err) {
      if (err.message !== 'unauthenticated') archiveError.textContent = 'Could not save.';
    }
  });

  async function loadDeletedMessages() {
    const list = document.getElementById('deleted-list');
    const empty = document.getElementById('deleted-empty');
    try {
      const res = await api('/api/contacts/' + contactId + '/deleted-messages');
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

  // Same inline img/video/audio preview (falling back to a download link)
  // as group.js's media archive section.
  function renderInlineMediaPreview(container, mimeType, url) {
    container.innerHTML = '';
    let el;
    if (mimeType.startsWith('image/')) {
      el = document.createElement('img');
      el.src = url;
      el.style.maxWidth = '280px';
      el.style.maxHeight = '280px';
      el.style.display = 'block';
      el.style.borderRadius = '6px';
    } else if (mimeType.startsWith('video/')) {
      el = document.createElement('video');
      el.src = url;
      el.controls = true;
      el.style.maxWidth = '280px';
      el.style.maxHeight = '280px';
    } else if (mimeType.startsWith('audio/')) {
      el = document.createElement('audio');
      el.src = url;
      el.controls = true;
    }
    if (el) container.appendChild(el);

    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.target = '_blank';
    downloadLink.rel = 'noopener';
    downloadLink.textContent = el ? 'Download' : 'Download / open';
    downloadLink.style.display = 'block';
    downloadLink.style.marginTop = '4px';
    downloadLink.style.fontSize = '12px';
    container.appendChild(downloadLink);
  }

  async function loadMediaArchive() {
    const list = document.getElementById('media-list');
    const empty = document.getElementById('media-empty');
    try {
      const res = await api('/api/contacts/' + contactId + '/media-archive');
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
        const preview = document.createElement('div');
        preview.className = 'hidden';
        preview.style.marginTop = '8px';
        viewBtn.addEventListener('click', async () => {
          if (!preview.classList.contains('hidden')) {
            preview.classList.add('hidden');
            return;
          }
          const urlRes = await api(
            '/api/contacts/' + contactId + '/media-archive/' + item.id + '/url',
          );
          if (!urlRes.ok) return;
          const urlData = await urlRes.json();
          renderInlineMediaPreview(preview, item.mimeType, urlData.url);
          preview.classList.remove('hidden');
        });
        detail.appendChild(viewBtn);
        detail.appendChild(preview);
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

  // ---------- Auto-reply rules ----------

  const ruleForm = document.getElementById('rule-form');
  const ruleList = document.getElementById('rule-list');
  const rulesEmpty = document.getElementById('rules-empty');
  const rulesError = document.getElementById('rules-error');

  function updateRuleFormFields() {
    const triggerType = document.getElementById('rule-trigger-type').value;
    const isEscalation = triggerType === 'escalation';
    const usesAi = !isEscalation && document.getElementById('rule-classifier').value === 'ai';
    document
      .getElementById('rule-fields-phrases')
      .classList.toggle('hidden', isEscalation ? false : usesAi);
    document.getElementById('rule-ai-instructions-field').classList.toggle('hidden', !usesAi);
    document.getElementById('rule-classifier-field').classList.toggle('hidden', isEscalation);
    document.getElementById('rule-fields-escalation').classList.toggle('hidden', !isEscalation);
    document.getElementById('rule-action-type-field').classList.toggle('hidden', isEscalation);
    updateRuleMessageVisibility();
  }

  function updateRuleMessageVisibility() {
    const triggerType = document.getElementById('rule-trigger-type').value;
    const action = document.getElementById('rule-action-type').value;
    document
      .getElementById('rule-message-field')
      .classList.toggle('hidden', triggerType === 'escalation' || action === 'AI_REPLY');
  }

  document.getElementById('rule-trigger-type').addEventListener('change', updateRuleFormFields);
  document.getElementById('rule-classifier').addEventListener('change', updateRuleFormFields);
  document
    .getElementById('rule-action-type')
    .addEventListener('change', updateRuleMessageVisibility);

  function matchModeLabel(mode) {
    return (
      { contains: 'contains', exact: 'exactly matches', keyword_any: 'has the word' }[mode] || mode
    );
  }

  function actionText(action) {
    if (action.type === 'SEND_MESSAGE') return 'send "' + action.message + '"';
    if (action.type === 'AI_REPLY') return 'reply with an AI-generated message';
    return 'log only';
  }

  function renderRuleSummary(rule) {
    const cfg = rule.config;
    const cooldown = cfg.cooldownSeconds > 0 ? ', cooldown ' + cfg.cooldownSeconds + 's' : '';

    if (rule.triggerType === 'escalation') {
      const q = cfg.qualify;
      const phrasesText = q.phrases.map((p) => '"' + p + '"').join(', ');
      const parts = [];
      if (cfg.action.notifyOwner) parts.push('notify the owner');
      if (cfg.action.createInboxItem) parts.push('create an Owner Inbox item');
      if (cfg.action.suppressAutoReply) parts.push('suppress auto-reply for that message');
      return (
        'When the message ' +
        matchModeLabel(q.mode) +
        ' ' +
        phrasesText +
        ', escalate as "' +
        cfg.action.category +
        '": ' +
        (parts.join(', ') || 'log only') +
        cooldown +
        '.'
      );
    }

    const qualifyText =
      cfg.qualify.classifier === 'ai'
        ? 'AI decides the message ' + cfg.qualify.aiInstructions
        : 'the message ' +
          matchModeLabel(cfg.qualify.mode) +
          ' ' +
          cfg.qualify.phrases.map((p) => '"' + p + '"').join(', ');
    return 'When ' + qualifyText + ', ' + actionText(cfg.action) + cooldown + '.';
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
      const res = await api('/api/contacts/' + contactId + '/rules');
      const data = await res.json();
      renderRules(data.rules || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') rulesError.textContent = 'Could not load rules.';
    }
  }

  async function setRuleEnabled(ruleId, enabled) {
    try {
      await api('/api/contacts/' + contactId + '/rules/' + ruleId, {
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
      await api('/api/contacts/' + contactId + '/rules/' + ruleId, { method: 'DELETE' });
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

  // ---------- Automation Templates ----------
  // Templates only pre-fill this same rule-builder form — the owner still
  // reviews and clicks "Create Rule" themselves. See /templates.js.

  const templatePicker = document.getElementById('rule-template-picker');
  const RULE_TEMPLATES = (window.RULE_TEMPLATES || []).filter((t) =>
    t.appliesTo.includes('contact'),
  );
  for (const template of RULE_TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = template.id;
    opt.textContent = template.label;
    templatePicker.appendChild(opt);
  }

  function applyTemplate(template) {
    const f = template.fields;
    document.getElementById('rule-name').value = f.name || '';
    document.getElementById('rule-trigger-type').value = f.triggerType;
    if (f.classifier) document.getElementById('rule-classifier').value = f.classifier;
    if (f.matchMode) document.getElementById('rule-match-mode').value = f.matchMode;
    document.getElementById('rule-phrases').value = f.phrases || '';
    document.getElementById('rule-ai-instructions').value = f.aiInstructions || '';
    document.getElementById('rule-cooldown').value = '0';
    document.getElementById('rule-category').value = f.category || '';
    document.getElementById('rule-notify-owner').checked = f.notifyOwner !== false;
    document.getElementById('rule-create-inbox-item').checked = f.createInboxItem !== false;
    document.getElementById('rule-suppress-auto-reply').checked = Boolean(f.suppressAutoReply);

    updateRuleFormFields();
    if (f.actionType) document.getElementById('rule-action-type').value = f.actionType;
    document.getElementById('rule-message').value = f.message || '';
    updateRuleMessageVisibility();

    rulesError.textContent = template.note ? 'Template note: ' + template.note : '';
    ruleForm.classList.remove('hidden');
  }

  templatePicker.addEventListener('change', () => {
    const template = RULE_TEMPLATES.find((t) => t.id === templatePicker.value);
    templatePicker.value = '';
    if (template) applyTemplate(template);
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
      triggerType: document.getElementById('rule-trigger-type').value,
      phrases,
      matchMode: document.getElementById('rule-match-mode').value,
      classifier: document.getElementById('rule-classifier').value,
      aiInstructions: document.getElementById('rule-ai-instructions').value,
      cooldownSeconds: document.getElementById('rule-cooldown').value,
      actionType: document.getElementById('rule-action-type').value,
      message: document.getElementById('rule-message').value,
      category: document.getElementById('rule-category').value.trim(),
      notifyOwner: document.getElementById('rule-notify-owner').checked,
      createInboxItem: document.getElementById('rule-create-inbox-item').checked,
      suppressAutoReply: document.getElementById('rule-suppress-auto-reply').checked,
    };

    try {
      const res = await api('/api/contacts/' + contactId + '/rules', {
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
      document.getElementById('rule-ai-instructions').value = '';
      document.getElementById('rule-cooldown').value = '0';
      document.getElementById('rule-message').value = '';
      document.getElementById('rule-category').value = '';
      document.getElementById('rule-notify-owner').checked = true;
      document.getElementById('rule-create-inbox-item').checked = true;
      document.getElementById('rule-suppress-auto-reply').checked = true;
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

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function prettyAction(actionType) {
    return (actionType || '').toLowerCase().replace(/_/g, ' ');
  }

  // "Why did the bot do this?" — see group.js's identical function for the
  // reasoning; kept duplicated rather than shared since this project has no
  // bundler/module system across dashboard pages.
  function explainEntry(entry, kind) {
    const d = entry.detail || {};
    if (kind === 'action') {
      let text = 'Action: ' + prettyAction(entry.actionType) + ' — ' + entry.status + '.';
      if (d.reason === 'cooldown_active') {
        text +=
          ' Skipped: still in cooldown' +
          (d.remainingSeconds ? ' (' + d.remainingSeconds + 's remaining)' : '') +
          '.';
      } else if (d.reason === 'dry_run') {
        text +=
          ' Dry Run — would have: ' + (d.wouldHaveActed || prettyAction(entry.actionType)) + '.';
      } else if (d.message) {
        text += ' ' + d.message;
      }
      return text;
    }

    switch (entry.eventType) {
      case 'rule.fired':
        return (
          'Rule "' +
          d.ruleName +
          '" (' +
          (d.triggerType || '') +
          ') matched. Action: ' +
          prettyAction(d.actionType) +
          ' — ' +
          d.actionStatus +
          '.'
        );
      case 'rule.fired_but_action_skipped':
        return (
          'Rule "' +
          d.ruleName +
          '" matched but the action was skipped (' +
          (d.reason === 'cooldown_active'
            ? 'still in cooldown' +
              (d.remainingSeconds ? ', ' + d.remainingSeconds + 's remaining' : '')
            : d.reason) +
          ').'
        );
      case 'rule.dry_run':
        return 'Dry Run: rule "' + d.ruleName + '" matched. Would have: ' + d.wouldHaveActed + '.';
      case 'escalation.fired':
        return (
          'Escalation rule "' +
          d.ruleName +
          '" fired (category: ' +
          d.category +
          ') — owner notified.'
        );
      case 'escalation.dry_run':
        return (
          'Dry Run: escalation rule "' +
          d.ruleName +
          '" would have fired (category: ' +
          d.category +
          ').'
        );
      case 'automation.paused_skip':
        return 'Emergency Pause is on — no automatic action was taken.';
      case 'message.deleted':
        return (
          'A message was deleted.' +
          (d.archived
            ? ' Archived before deletion.'
            : ' Not archived (monitoring was off when it arrived).') +
          (d.hasArchivedMedia ? ' Its media is still viewable.' : '')
        );
      case 'media.archived':
        return 'Archived incoming media (' + d.mimeType + ', ' + fmtBytes(d.fileSizeBytes) + ').';
      case 'media.view_once_archived':
        return 'Archived a view-once ' + d.mimeType + ' before it disappeared.';
      case 'config.changed':
        return 'Owner changed settings: ' + Object.keys(d.patch || {}).join(', ') + '.';
      case 'human_takeover.changed':
        return d.humanTakeoverUntil
          ? 'Human Takeover started.'
          : 'Human Takeover ended — automation resumed.';
      case 'message.received':
        return 'Message received (' + d.messageType + ').';
      default:
        return entry.eventType.replace(/\./g, ' ');
    }
  }

  async function loadActivity() {
    try {
      const res = await api(
        '/api/activity?contactId=' + encodeURIComponent(contactId) + '&limit=25',
      );
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
        detail.textContent = explainEntry(entry, entry.kind);
        const time = document.createElement('div');
        time.className = 'activity-time';
        time.textContent = fmtDate(entry.createdAt);
        row.appendChild(label);
        row.appendChild(detail);
        row.appendChild(time);
        activityList.appendChild(row);
      }
    } catch {
      // Non-critical.
    }
  }

  // ---------- Init ----------

  async function init() {
    try {
      const res = await api('/api/contacts/' + contactId);
      if (res.status === 404) {
        loadError.textContent = 'This contact was not found.';
        return;
      }
      if (!res.ok) throw new Error('failed');
      const data = await res.json();

      currentContact = data.contact;
      contactSubject.textContent = currentContact.displayName || currentContact.whatsappJid;
      contactMeta.textContent =
        currentContact.accountLabel + ' · first seen ' + fmtDate(currentContact.discoveredAt);
      blockedToggle.checked = Boolean(currentContact.blocked);
      document.getElementById('display-name').value = currentContact.displayName || '';

      currentSettings = data.settings;
      renderGeneral(data.settings);
      renderAi(data.settings);
      renderArchive(data.settings);
      renderMediaArchiveToggles(data.settings);
      renderCapability(data.risk, data.capabilitySummary);
      content.classList.remove('hidden');

      await Promise.all([loadRules(), loadActivity(), loadDeletedMessages(), loadMediaArchive()]);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        loadError.textContent = 'Could not load this contact.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  init();
})();
