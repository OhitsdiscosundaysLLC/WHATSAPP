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

  const consoleError = document.getElementById('console-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const consoleContent = document.getElementById('console-content');
  const accountSelect = document.getElementById('account-select');
  const destinationSelect = document.getElementById('destination-select');
  const typeSelect = document.getElementById('type-select');
  const textField = document.getElementById('text-field');
  const textInput = document.getElementById('text-input');
  const fileField = document.getElementById('file-field');
  const fileInput = document.getElementById('file-input');
  const filePreview = document.getElementById('file-preview');
  const captionField = document.getElementById('caption-field');
  const captionInput = document.getElementById('caption-input');
  const viewOnceField = document.getElementById('view-once-field');
  const viewOnceCheckbox = document.getElementById('view-once-checkbox');
  const sendBtn = document.getElementById('send-btn');
  const sendStatus = document.getElementById('send-status');

  /** Only the types WhatsApp's own clients offer a caption for. */
  const CAPTION_TYPES = new Set(['image', 'video', 'document']);
  /** Only the types WhatsApp's own clients offer View Once for. */
  const VIEW_ONCE_TYPES = new Set(['image', 'video', 'audio', 'voice_note']);
  const ACCEPT_BY_TYPE = {
    image: 'image/*',
    video: 'video/*',
    audio: 'audio/*',
    voice_note: 'audio/*',
    document: '',
  };

  let destinationsByAccount = { groups: [], contacts: [] };

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }

  function renderFieldVisibility() {
    const type = typeSelect.value;
    textField.classList.toggle('hidden', type !== 'text');
    fileField.classList.toggle('hidden', type === 'text');
    captionField.classList.toggle('hidden', !CAPTION_TYPES.has(type));
    viewOnceField.classList.toggle('hidden', !VIEW_ONCE_TYPES.has(type));
    if (type !== 'text') fileInput.accept = ACCEPT_BY_TYPE[type] || '';
    filePreview.innerHTML = '';
    fileInput.value = '';
  }

  function renderDestinationOptions() {
    const accountId = accountSelect.value;
    destinationSelect.innerHTML = '<option value="self">Myself (Message Yourself)</option>';
    const groups = destinationsByAccount.groups.filter((g) => g.accountId === accountId);
    const contacts = destinationsByAccount.contacts.filter((c) => c.accountId === accountId);
    if (groups.length) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = 'Groups';
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = 'group:' + g.id;
        opt.textContent = g.label;
        optgroup.appendChild(opt);
      }
      destinationSelect.appendChild(optgroup);
    }
    if (contacts.length) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = 'Contacts';
      for (const c of contacts) {
        const opt = document.createElement('option');
        opt.value = 'contact:' + c.id;
        opt.textContent = c.label;
        optgroup.appendChild(opt);
      }
      destinationSelect.appendChild(optgroup);
    }
  }

  fileInput.addEventListener('change', () => {
    filePreview.innerHTML = '';
    const file = fileInput.files[0];
    if (!file) return;
    const type = typeSelect.value;
    if (type === 'image') {
      const img = document.createElement('img');
      img.style.maxWidth = '220px';
      img.style.maxHeight = '220px';
      img.style.borderRadius = '8px';
      img.src = URL.createObjectURL(file);
      filePreview.appendChild(img);
    } else if (type === 'video') {
      const video = document.createElement('video');
      video.style.maxWidth = '220px';
      video.controls = true;
      video.src = URL.createObjectURL(file);
      filePreview.appendChild(video);
    } else if (type === 'audio' || type === 'voice_note') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = URL.createObjectURL(file);
      filePreview.appendChild(audio);
    } else {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.fontSize = '12px';
      p.textContent = file.name + ' (' + Math.ceil(file.size / 1024) + ' KB)';
      filePreview.appendChild(p);
    }
  });

  typeSelect.addEventListener('change', renderFieldVisibility);
  accountSelect.addEventListener('change', renderDestinationOptions);

  sendBtn.addEventListener('click', async () => {
    consoleError.textContent = '';
    sendStatus.textContent = '';
    const accountId = accountSelect.value;
    const destinationValue = destinationSelect.value;
    const messageType = typeSelect.value;
    if (!accountId) {
      consoleError.textContent = 'Choose an account to send from.';
      return;
    }

    const payload = {
      requestId:
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      accountId,
      messageType,
    };
    if (destinationValue === 'self') {
      payload.destinationType = 'self';
    } else {
      const [kind, id] = destinationValue.split(':');
      payload.destinationType = kind;
      payload.destinationId = id;
    }

    if (messageType === 'text') {
      const text = textInput.value.trim();
      if (!text) {
        consoleError.textContent = 'Type a message first.';
        return;
      }
      payload.text = text;
    } else {
      const file = fileInput.files[0];
      if (!file) {
        consoleError.textContent = 'Choose a file first.';
        return;
      }
      try {
        payload.fileBase64 = await readFileAsBase64(file);
      } catch (err) {
        consoleError.textContent = 'Could not read that file.';
        return;
      }
      payload.mimeType = file.type || 'application/octet-stream';
      payload.fileName = file.name;
      if (CAPTION_TYPES.has(messageType) && captionInput.value.trim()) {
        payload.caption = captionInput.value.trim();
      }
      if (VIEW_ONCE_TYPES.has(messageType) && viewOnceCheckbox.checked) {
        payload.viewOnce = true;
      }
    }

    sendBtn.disabled = true;
    sendStatus.textContent = 'Sending...';
    try {
      const res = await api('/api/media-console/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        sendStatus.textContent = '';
        consoleError.textContent = data.message || data.error || 'Could not send.';
        return;
      }
      sendStatus.textContent = 'Sent ✓ — see the Message Vault for a record.';
      if (messageType === 'text') textInput.value = '';
      fileInput.value = '';
      filePreview.innerHTML = '';
      captionInput.value = '';
      viewOnceCheckbox.checked = false;
    } catch (err) {
      sendStatus.textContent = '';
      if (err.message !== 'unauthenticated')
        consoleError.textContent = 'Could not reach the server.';
    } finally {
      sendBtn.disabled = false;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  (async () => {
    try {
      const res = await api('/api/media-console/destinations');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        consoleContent.classList.add('hidden');
        return;
      }
      const data = await res.json();
      destinationsByAccount = { groups: data.groups || [], contacts: data.contacts || [] };
      accountSelect.innerHTML = '';
      for (const account of data.accounts || []) {
        const opt = document.createElement('option');
        opt.value = account.id;
        opt.textContent = account.label + (account.connected ? '' : ' (not connected)');
        accountSelect.appendChild(opt);
      }
      renderDestinationOptions();
      renderFieldVisibility();
    } catch (err) {
      if (err.message !== 'unauthenticated')
        consoleError.textContent = 'Could not load accounts/destinations.';
    }
  })();
})();
