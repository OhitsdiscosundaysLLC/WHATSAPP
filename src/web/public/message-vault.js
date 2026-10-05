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

  // Mirrors group.js/contact.js's renderInlineMediaPreview — kept as its
  // own copy per this project's "no shared module between dashboard pages"
  // convention (every src/web/public/*.js file is an independent IIFE).
  function renderInlineMediaPreview(container, mimeType, url) {
    container.innerHTML = '';
    let el;
    if (mimeType && mimeType.startsWith('image/')) {
      el = document.createElement('img');
      el.src = url;
      el.style.maxWidth = '280px';
      el.style.maxHeight = '280px';
      el.style.display = 'block';
      el.style.borderRadius = '6px';
    } else if (mimeType && mimeType.startsWith('video/')) {
      el = document.createElement('video');
      el.src = url;
      el.controls = true;
      el.style.maxWidth = '280px';
      el.style.maxHeight = '280px';
    } else if (mimeType && mimeType.startsWith('audio/')) {
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

  const vaultError = document.getElementById('vault-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const list = document.getElementById('vault-list');
  const empty = document.getElementById('vault-empty');

  const TYPE_LABEL = {
    text: 'Text',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    voice_note: 'Voice note',
    document: 'Document',
  };

  function renderRow(send) {
    const row = document.createElement('div');
    row.className = 'activity-item';

    const label = document.createElement('div');
    label.className = 'activity-event';
    const destination = send.groupId
      ? 'a group'
      : send.contactId
        ? 'a contact'
        : send.destinationJid;
    label.textContent =
      (TYPE_LABEL[send.messageType] || send.messageType) +
      ' sent to ' +
      destination +
      ' (' +
      send.destinationJid +
      ')' +
      (send.viewOnce ? ' — View Once' : '') +
      ' — ' +
      send.status;

    const detail = document.createElement('div');
    detail.className = 'activity-detail';
    if (send.textBody) {
      const p = document.createElement('p');
      p.style.margin = '4px 0';
      p.textContent = send.textBody;
      detail.appendChild(p);
    }
    if (send.caption) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.margin = '4px 0';
      p.style.fontSize = '12px';
      p.textContent = 'Caption: ' + send.caption;
      detail.appendChild(p);
    }
    if (send.errorMessage) {
      const p = document.createElement('p');
      p.className = 'error-text';
      p.style.margin = '4px 0';
      p.textContent = send.errorMessage;
      detail.appendChild(p);
    }
    if (send.messageType !== 'text') {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-sm';
      viewBtn.textContent = 'View sent media';
      const preview = document.createElement('div');
      preview.className = 'hidden';
      preview.style.marginTop = '8px';
      viewBtn.addEventListener('click', async () => {
        if (!preview.classList.contains('hidden')) {
          preview.classList.add('hidden');
          return;
        }
        const urlRes = await api('/api/media-console/sent/' + send.id + '/media-url');
        const urlData = await urlRes.json();
        if (!urlRes.ok) {
          preview.textContent = urlData.message || 'Not archived yet — try again shortly.';
          preview.classList.remove('hidden');
          return;
        }
        renderInlineMediaPreview(preview, send.mimeType, urlData.url);
        preview.classList.remove('hidden');
      });
      detail.appendChild(viewBtn);
      detail.appendChild(preview);
    }

    const time = document.createElement('div');
    time.className = 'activity-time';
    time.textContent = fmtDate(send.createdAt) + ' — from ' + send.accountLabel;

    row.appendChild(label);
    row.appendChild(detail);
    row.appendChild(time);
    return row;
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  (async () => {
    try {
      const res = await api('/api/media-console/sent?limit=100');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      const sends = data.sends || [];
      list.innerHTML = '';
      empty.classList.toggle('hidden', sends.length > 0);
      for (const send of sends) list.appendChild(renderRow(send));
    } catch (err) {
      if (err.message !== 'unauthenticated') vaultError.textContent = 'Could not load the vault.';
    }
  })();
})();
