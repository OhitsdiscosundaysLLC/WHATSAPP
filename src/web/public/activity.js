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

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function describeEntry(entry) {
    if (entry.kind === 'event') return entry.eventType.replace(/\./g, ' ');
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
      case 'preset.applied':
        return 'Applied preset "' + d.presetName + '".';
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

  const activityList = document.getElementById('activity-list');
  const activityEmpty = document.getElementById('activity-empty');
  const activityError = document.getElementById('activity-error');
  const unconfiguredState = document.getElementById('unconfigured-state');

  async function loadActivity() {
    activityError.textContent = '';
    try {
      const res = await api('/api/activity?limit=100');
      if (res.status === 503) {
        unconfiguredState.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      const merged = [
        ...(data.events || []).map((e) => ({ ...e, kind: 'event' })),
        ...(data.actions || []).map((a) => ({ ...a, kind: 'action' })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      activityList.innerHTML = '';
      activityEmpty.classList.toggle('hidden', merged.length > 0);
      for (const entry of merged.slice(0, 100)) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        const label = document.createElement('div');
        label.className = 'activity-event';
        label.textContent = describeEntry(entry);
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
    } catch (err) {
      if (err.message !== 'unauthenticated') {
        activityError.textContent = 'Could not load activity.';
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  loadActivity();
})();
