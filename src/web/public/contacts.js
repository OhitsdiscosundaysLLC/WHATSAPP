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

  const list = document.getElementById('contact-list');
  const emptyState = document.getElementById('empty-state');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const contactsError = document.getElementById('contacts-error');

  function renderContacts(contacts) {
    list.innerHTML = '';
    emptyState.classList.toggle('hidden', contacts.length > 0);

    for (const contact of contacts) {
      const row = document.createElement('a');
      row.className = 'card group-row';
      row.href = '/contacts/' + contact.id;

      const main = document.createElement('div');
      main.className = 'group-row-main';
      const subject = document.createElement('div');
      subject.className = 'group-subject';
      subject.textContent = contact.displayName || contact.whatsappJid;
      const meta = document.createElement('div');
      meta.className = 'account-meta';
      meta.textContent =
        contact.accountLabel +
        ' · ' +
        contact.ruleCount +
        ' rule' +
        (contact.ruleCount === 1 ? '' : 's');
      main.appendChild(subject);
      main.appendChild(meta);

      const pills = document.createElement('div');
      pills.className = 'group-row-pills';
      if (contact.blocked) {
        pills.appendChild(pill('Blocked', 'status-error'));
      } else {
        pills.appendChild(
          pill(
            'Monitoring ' + (contact.privateMonitoringEnabled ? 'ON' : 'OFF'),
            contact.privateMonitoringEnabled ? 'status-connected' : 'status-neutral',
          ),
        );
        pills.appendChild(
          pill(
            'AI ' + (contact.privateAiEnabled ? 'ON' : 'OFF'),
            contact.privateAiEnabled ? 'status-connected' : 'status-neutral',
          ),
        );
        pills.appendChild(
          pill(
            'Auto Reply ' + (contact.privateAutoReplyEnabled ? 'ON' : 'OFF'),
            contact.privateAutoReplyEnabled ? 'status-connected' : 'status-neutral',
          ),
        );
      }

      row.appendChild(main);
      row.appendChild(pills);
      list.appendChild(row);
    }
  }

  async function loadContacts() {
    contactsError.textContent = '';
    try {
      const res = await api('/api/contacts');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      renderContacts(data.contacts || []);
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        contactsError.textContent = 'Could not load contacts.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadContacts();
})();
