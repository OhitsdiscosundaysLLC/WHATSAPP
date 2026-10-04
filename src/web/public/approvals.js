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

  const STATUS_LABEL = {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    sent: 'Sent',
    failed: 'Failed to send',
  };

  const approvalsList = document.getElementById('approvals-list');
  const approvalsEmpty = document.getElementById('approvals-empty');
  const approvalsError = document.getElementById('approvals-error');
  const unconfiguredState = document.getElementById('unconfigured-state');
  const showDecidedFilter = document.getElementById('show-decided-filter');

  function renderCard(approval) {
    const card = document.createElement('div');
    card.className = 'card rule-card';
    card.style.marginBottom = '14px';
    card.style.padding = '16px';

    const top = document.createElement('div');
    top.className = 'rule-card-top';
    const title = document.createElement('div');
    title.className = 'rule-name';
    title.textContent = approval.accountLabel + '  ·  ' + approval.targetChatJid;
    const pill = document.createElement('span');
    const pillStatusClass =
      approval.status === 'pending'
        ? 'status-neutral'
        : approval.status === 'sent' || approval.status === 'approved'
          ? 'status-connected'
          : 'status-error';
    pill.className = 'status-pill ' + pillStatusClass;
    pill.innerHTML = '<span class="status-dot"></span><span></span>';
    pill.querySelector('span:last-child').textContent =
      STATUS_LABEL[approval.status] || approval.status;
    top.appendChild(title);
    top.appendChild(pill);
    card.appendChild(top);

    const time = document.createElement('div');
    time.className = 'activity-time';
    time.textContent = 'Proposed ' + fmtDate(approval.createdAt);
    card.appendChild(time);

    const textarea = document.createElement('textarea');
    textarea.value = approval.proposedMessage;
    textarea.style.marginTop = '10px';
    textarea.disabled = approval.status !== 'pending';
    card.appendChild(textarea);

    if (approval.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'rule-actions';
      actions.style.marginTop = '10px';

      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-primary btn-sm';
      approveBtn.textContent = 'Approve & Send';
      approveBtn.addEventListener('click', async () => {
        approvalsError.textContent = '';
        try {
          const edited = textarea.value.trim();
          const body = edited !== approval.proposedMessage.trim() ? { editedMessage: edited } : {};
          const res = await api('/api/approvals/' + approval.id + '/approve', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok) {
            approvalsError.textContent = data.message || 'Could not approve.';
            return;
          }
          await loadApprovals();
        } catch (err) {
          if (err.message !== 'unauthenticated') approvalsError.textContent = 'Could not approve.';
        }
      });

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn btn-sm btn-danger';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', async () => {
        if (!window.confirm('Discard this proposed reply without sending it?')) return;
        approvalsError.textContent = '';
        try {
          const res = await api('/api/approvals/' + approval.id + '/reject', { method: 'POST' });
          const data = await res.json();
          if (!res.ok) {
            approvalsError.textContent = data.message || 'Could not reject.';
            return;
          }
          await loadApprovals();
        } catch (err) {
          if (err.message !== 'unauthenticated') approvalsError.textContent = 'Could not reject.';
        }
      });

      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);
      card.appendChild(actions);
    }

    return card;
  }

  async function loadApprovals() {
    approvalsError.textContent = '';
    try {
      const status = showDecidedFilter.checked ? '' : 'status=pending&';
      const res = await api('/api/approvals?' + status + 'limit=100');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      const approvals = data.approvals || [];

      approvalsList.innerHTML = '';
      approvalsEmpty.classList.toggle('hidden', approvals.length > 0);
      for (const approval of approvals) {
        approvalsList.appendChild(renderCard(approval));
      }
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        approvalsError.textContent = 'Could not load approvals.';
      }
    }
  }

  showDecidedFilter.addEventListener('change', loadApprovals);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadApprovals();
})();
