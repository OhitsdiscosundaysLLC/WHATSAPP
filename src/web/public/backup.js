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

  const backupError = document.getElementById('backup-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const backupContent = document.getElementById('backup-content');
  const exportAccountSelect = document.getElementById('export-account');
  const importAccountSelect = document.getElementById('import-account');
  const importFileInput = document.getElementById('import-file');
  const previewBtn = document.getElementById('preview-import-btn');
  const applyBtn = document.getElementById('apply-import-btn');
  const importPlan = document.getElementById('import-plan');
  const planGroups = document.getElementById('plan-groups');
  const planContacts = document.getElementById('plan-contacts');
  const planPresets = document.getElementById('plan-presets');
  const importResult = document.getElementById('import-result');
  const importResultText = document.getElementById('import-result-text');

  let pendingDocument = null;

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsText(file);
    });
  }

  function renderPlanRow(container, matchedLabel, unmatchedLabel, matched) {
    const row = document.createElement('div');
    row.style.fontSize = '13px';
    row.style.marginBottom = '4px';
    row.textContent = matched ? matchedLabel : unmatchedLabel;
    row.className = matched ? '' : 'muted';
    container.appendChild(row);
  }

  function renderPlan(plan) {
    planGroups.innerHTML = '';
    if (!plan.groups.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.fontSize = '12px';
      p.textContent = 'No groups in this backup.';
      planGroups.appendChild(p);
    }
    for (const g of plan.groups) {
      renderPlanRow(
        planGroups,
        g.subject +
          ' — will update settings, ' +
          g.rulesToCreate +
          ' new rule(s), ' +
          g.rulesToUpdate +
          ' updated rule(s)',
        g.subject + ' — not found on target account, will be skipped',
        g.matched,
      );
    }

    planContacts.innerHTML = '';
    if (!plan.contacts.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.fontSize = '12px';
      p.textContent = 'No private contacts in this backup.';
      planContacts.appendChild(p);
    }
    for (const c of plan.contacts) {
      const label = c.displayName || c.whatsappJid;
      renderPlanRow(
        planContacts,
        label +
          ' — will update settings, ' +
          c.rulesToCreate +
          ' new rule(s), ' +
          c.rulesToUpdate +
          ' updated rule(s)',
        label + ' — not found on target account, will be skipped',
        c.matched,
      );
    }

    planPresets.innerHTML = '';
    if (!plan.presets.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.fontSize = '12px';
      p.textContent = 'No presets in this backup.';
      planPresets.appendChild(p);
    }
    for (const preset of plan.presets) {
      renderPlanRow(
        planPresets,
        preset.name + ' — will be created',
        preset.name + ' — already exists on target account, will be skipped',
        preset.willCreate,
      );
    }

    importPlan.classList.remove('hidden');
  }

  document.getElementById('export-btn').addEventListener('click', async () => {
    backupError.textContent = '';
    const accountId = exportAccountSelect.value;
    if (!accountId) return;
    try {
      const res = await api('/api/backup/export?accountId=' + accountId);
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        backupContent.classList.add('hidden');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        backupError.textContent = data.message || 'Could not export backup.';
        return;
      }
      const blob = new Blob([JSON.stringify(data.document, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const accountLabel = exportAccountSelect.selectedOptions[0]
        ? exportAccountSelect.selectedOptions[0].textContent
        : 'account';
      const safeLabel = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      a.href = url;
      a.download =
        'whatsapp-bot-backup-' + safeLabel + '-' + data.document.exportedAt.slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err.message !== 'unauthenticated')
        backupError.textContent = 'Could not reach the server.';
    }
  });

  previewBtn.addEventListener('click', async () => {
    backupError.textContent = '';
    importPlan.classList.add('hidden');
    importResult.classList.add('hidden');
    applyBtn.classList.add('hidden');
    pendingDocument = null;

    const targetAccountId = importAccountSelect.value;
    const file = importFileInput.files[0];
    if (!targetAccountId || !file) {
      backupError.textContent = 'Choose a target account and a backup file.';
      return;
    }

    let document_;
    try {
      const text = await readFileAsText(file);
      document_ = JSON.parse(text);
    } catch (err) {
      backupError.textContent = 'That file is not valid JSON.';
      return;
    }

    try {
      const res = await api('/api/backup/import/preview', {
        method: 'POST',
        body: JSON.stringify({ targetAccountId, document: document_ }),
      });
      const data = await res.json();
      if (!res.ok) {
        backupError.textContent = data.message || 'This backup file could not be validated.';
        return;
      }
      pendingDocument = document_;
      renderPlan(data.plan);
      applyBtn.classList.remove('hidden');
    } catch (err) {
      if (err.message !== 'unauthenticated')
        backupError.textContent = 'Could not reach the server.';
    }
  });

  applyBtn.addEventListener('click', async () => {
    backupError.textContent = '';
    const targetAccountId = importAccountSelect.value;
    if (!targetAccountId || !pendingDocument) return;
    if (
      !window.confirm(
        'Apply this import? Matched groups/contacts will have their settings and rules updated.',
      )
    ) {
      return;
    }

    try {
      const res = await api('/api/backup/import/apply', {
        method: 'POST',
        body: JSON.stringify({ targetAccountId, document: pendingDocument }),
      });
      const data = await res.json();
      if (!res.ok) {
        backupError.textContent = data.message || 'Could not apply the import.';
        return;
      }
      const r = data.result;
      importResultText.textContent =
        'Applied: ' +
        r.groupsMatched +
        ' group(s) updated (' +
        r.groupsSkipped +
        ' skipped), ' +
        r.contactsMatched +
        ' contact(s) updated (' +
        r.contactsSkipped +
        ' skipped), ' +
        r.rulesCreated +
        ' rule(s) created, ' +
        r.rulesUpdated +
        ' rule(s) updated, ' +
        r.presetsCreated +
        ' preset(s) created (' +
        r.presetsSkipped +
        ' skipped).';
      importResult.classList.remove('hidden');
      applyBtn.classList.add('hidden');
      pendingDocument = null;
    } catch (err) {
      if (err.message !== 'unauthenticated')
        backupError.textContent = 'Could not reach the server.';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  (async () => {
    try {
      const res = await api('/api/accounts');
      const data = await res.json();
      for (const account of data.accounts || []) {
        const opt1 = document.createElement('option');
        opt1.value = account.id;
        opt1.textContent = account.label;
        exportAccountSelect.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = account.id;
        opt2.textContent = account.label;
        importAccountSelect.appendChild(opt2);
      }
    } catch (err) {
      if (err.message !== 'unauthenticated') backupError.textContent = 'Could not load accounts.';
    }
  })();
})();
