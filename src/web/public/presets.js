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

  // The curated subset of PRESET_SETTINGS_FIELDS this editor exposes as
  // simple toggles — the full allowlist (src/db/presetsRepository.ts)
  // accepts more, but a preset only needs to cover the settings owners
  // actually reuse across groups; anything not shown here is simply not
  // included when the preset is saved.
  const PRESET_TOGGLES = [
    { key: 'botEnabled', label: 'Bot' },
    { key: 'monitoringEnabled', label: 'Monitoring' },
    { key: 'autoReplyEnabled', label: 'Auto-Reply' },
    { key: 'aiEnabled', label: 'AI' },
    { key: 'aiAutoReplyEnabled', label: 'AI Auto-Reply' },
    { key: 'aiSemanticClassificationEnabled', label: 'AI Semantic Classification' },
    { key: 'moderationEnabled', label: 'Moderation' },
    { key: 'moderationDestructiveActionsEnabled', label: 'Moderation destructive actions' },
    { key: 'deletedMessageArchiveEnabled', label: 'Deleted-message archive' },
    { key: 'viewOnceHandlingEnabled', label: 'View-once archive' },
    { key: 'mediaArchiveEnabled', label: 'General media archive' },
    { key: 'callHandlingEnabled', label: 'Call handling' },
    { key: 'dryRunEnabled', label: 'Dry Run' },
    { key: 'approvalRequired', label: 'Require owner approval before sending' },
    { key: 'vip', label: 'VIP (label only)' },
    { key: 'neverAutoReply', label: 'Never Auto Reply' },
    { key: 'neverModerate', label: 'Never Moderate' },
    { key: 'quietHoursEnabled', label: 'Quiet Hours' },
  ];

  const presetsError = document.getElementById('presets-error');
  const presetList = document.getElementById('preset-list');
  const presetsEmpty = document.getElementById('presets-empty');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const presetForm = document.getElementById('preset-form');
  const presetFormTitle = document.getElementById('preset-form-title');
  const accountSelect = document.getElementById('preset-account');
  const settingsToggles = document.getElementById('preset-settings-toggles');

  let accounts = [];
  let editingPresetId = null;

  function renderToggles(settings) {
    settingsToggles.innerHTML = '';
    for (const def of PRESET_TOGGLES) {
      const row = document.createElement('div');
      row.className = 'toggle-row';
      const label = document.createElement('div');
      label.className = 'toggle-label';
      const text = document.createElement('div');
      text.className = 'toggle-label-text';
      text.textContent = def.label;
      label.appendChild(text);

      const toggle = document.createElement('label');
      toggle.className = 'toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.key = def.key;
      input.checked = Boolean(settings && settings[def.key]);
      const track = document.createElement('span');
      track.className = 'toggle-track';
      const thumb = document.createElement('span');
      thumb.className = 'toggle-thumb';
      toggle.appendChild(input);
      toggle.appendChild(track);
      toggle.appendChild(thumb);

      row.appendChild(label);
      row.appendChild(toggle);
      settingsToggles.appendChild(row);
    }
  }

  function collectSettings() {
    const settings = {};
    for (const input of settingsToggles.querySelectorAll('input[type="checkbox"]')) {
      settings[input.dataset.key] = input.checked;
    }
    return settings;
  }

  function openForm(preset) {
    editingPresetId = preset ? preset.id : null;
    presetFormTitle.textContent = preset ? 'Edit preset' : 'New preset';
    document.getElementById('preset-name').value = preset ? preset.name : '';
    accountSelect.value = preset ? preset.accountId : accountSelect.value;
    accountSelect.disabled = Boolean(preset);
    renderToggles(preset ? preset.settings : {});
    presetForm.classList.remove('hidden');
  }

  document.getElementById('new-preset-btn').addEventListener('click', () => openForm(null));
  document.getElementById('cancel-preset-btn').addEventListener('click', () => {
    presetForm.classList.add('hidden');
  });

  document.getElementById('save-preset-btn').addEventListener('click', async () => {
    presetsError.textContent = '';
    const name = document.getElementById('preset-name').value.trim();
    const accountId = accountSelect.value;
    if (!name || !accountId) {
      presetsError.textContent = 'Account and name are required.';
      return;
    }
    const settings = collectSettings();

    try {
      const res = editingPresetId
        ? await api('/api/group-presets/' + editingPresetId, {
            method: 'PATCH',
            body: JSON.stringify({ name, settings }),
          })
        : await api('/api/group-presets', {
            method: 'POST',
            body: JSON.stringify({ accountId, name, settings }),
          });
      const data = await res.json();
      if (!res.ok) {
        presetsError.textContent = data.message || 'Could not save the preset.';
        return;
      }
      presetForm.classList.add('hidden');
      await loadPresets();
    } catch (err) {
      if (err.message !== 'unauthenticated')
        presetsError.textContent = 'Could not reach the server.';
    }
  });

  function accountLabel(accountId) {
    const account = accounts.find((a) => a.id === accountId);
    return account ? account.label : 'Unknown account';
  }

  function renderPresets(presets) {
    presetList.innerHTML = '';
    presetsEmpty.classList.toggle('hidden', presets.length > 0);

    for (const preset of presets) {
      const card = document.createElement('div');
      card.className = 'card rule-card';

      const top = document.createElement('div');
      top.className = 'rule-card-top';
      const name = document.createElement('div');
      name.className = 'rule-name';
      name.textContent = preset.name + '  ·  ' + accountLabel(preset.accountId);
      top.appendChild(name);
      card.appendChild(top);

      const summary = document.createElement('div');
      summary.className = 'rule-summary';
      const onFields = Object.entries(preset.settings)
        .filter(([, v]) => v === true)
        .map(([k]) => (PRESET_TOGGLES.find((t) => t.key === k) || { label: k }).label);
      summary.textContent = onFields.length ? onFields.join(', ') : '(nothing enabled)';
      card.appendChild(summary);

      const actions = document.createElement('div');
      actions.className = 'rule-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openForm(preset));
      actions.appendChild(editBtn);

      const duplicateBtn = document.createElement('button');
      duplicateBtn.className = 'btn btn-sm';
      duplicateBtn.textContent = 'Duplicate';
      duplicateBtn.addEventListener('click', async () => {
        try {
          await api('/api/group-presets/' + preset.id + '/duplicate', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          await loadPresets();
        } catch (err) {
          if (err.message !== 'unauthenticated') presetsError.textContent = 'Could not duplicate.';
        }
      });
      actions.appendChild(duplicateBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!window.confirm('Delete this preset? Groups that already applied it are unaffected.'))
          return;
        try {
          await api('/api/group-presets/' + preset.id, { method: 'DELETE' });
          await loadPresets();
        } catch (err) {
          if (err.message !== 'unauthenticated') presetsError.textContent = 'Could not delete.';
        }
      });
      actions.appendChild(deleteBtn);

      card.appendChild(actions);
      presetList.appendChild(card);
    }
  }

  async function loadAccounts() {
    const res = await api('/api/accounts');
    const data = await res.json();
    accounts = data.accounts || [];
    accountSelect.innerHTML = '';
    for (const account of accounts) {
      const opt = document.createElement('option');
      opt.value = account.id;
      opt.textContent = account.label;
      accountSelect.appendChild(opt);
    }
  }

  async function loadPresets() {
    presetsError.textContent = '';
    try {
      const res = await api('/api/group-presets');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      renderPresets(data.presets || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') presetsError.textContent = 'Could not load presets.';
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  (async () => {
    await loadAccounts();
    await loadPresets();
  })();
})();
