import type { ContactSettings } from '../db/contactsRepository';
import type { GroupSettings } from '../db/groupsRepository';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskLabelResult {
  level: RiskLevel;
  /** Plain-language reasons for the computed level — always non-empty, so the owner never sees a bare label with no explanation. */
  reasons: string[];
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * The subset of settings the risk computation needs, named generically so
 * both `GroupSettings` and `ContactSettings` can map onto it (contacts
 * have no moderation and no master on/off switch — see
 * `contactRiskLabel()` below). `botEnabled` defaults to `true` when
 * omitted so the shared core never short-circuits for a shape that has no
 * such switch at all.
 */
export interface RiskLabelInput {
  botEnabled?: boolean;
  monitoringEnabled: boolean;
  autoReplyEnabled: boolean;
  aiEnabled: boolean;
  aiAutoReplyEnabled: boolean;
  moderationEnabled: boolean;
  moderationDestructiveActionsEnabled: boolean;
  approvalRequired: boolean;
  dryRunEnabled: boolean;
}

/**
 * Computes a plain, explainable risk level from the capabilities currently
 * turned on — never from anything the bot has actually *done* (that's a
 * separate, factual record in `bot_actions`/`whatsapp_audit_logs`). This
 * is a forward-looking "how much autonomous power does this grant right
 * now" signal, always paired with the reasons that produced it so the
 * owner is never left looking at an unexplained label.
 *
 * Dry Run is the one override that can only ever LOWER the computed
 * level: nothing it enables actually sends, deletes, or removes anything
 * for real, so a group/contact in Dry Run is always reported as `low`
 * regardless of which toggles are on underneath it.
 */
export function computeRiskLabel(input: RiskLabelInput): RiskLabelResult {
  const botEnabled = input.botEnabled ?? true;
  if (!botEnabled) {
    return { level: 'low', reasons: ['Bot is off — no automation can run here.'] };
  }

  const reasons: string[] = [];
  let level: RiskLevel = 'low';
  const raise = (to: RiskLevel, reason: string): void => {
    reasons.push(reason);
    if (RANK[to] > RANK[level]) level = to;
  };

  if (input.monitoringEnabled) {
    reasons.push('Monitoring is on — stores messages and can archive deleted content/media.');
  }
  if (input.autoReplyEnabled) {
    raise('medium', 'Auto-reply can send messages automatically when a rule matches.');
  }
  if (input.aiEnabled && input.aiAutoReplyEnabled) {
    raise('medium', 'AI can generate and send replies automatically.');
  }
  if (input.moderationEnabled) {
    raise('medium', 'Moderation rules can warn members automatically.');
  }
  if (input.moderationDestructiveActionsEnabled) {
    raise('high', 'Moderation can delete messages or remove members automatically.');
  }
  if (input.approvalRequired && (input.autoReplyEnabled || input.aiAutoReplyEnabled)) {
    reasons.push('Replies require owner approval before sending — lowers real-world risk.');
  }

  if (input.dryRunEnabled) {
    return {
      level: 'low',
      reasons: [
        'Dry Run is on — the bot logs what it would do but never sends, deletes, or removes anything for real.',
      ],
    };
  }

  if (reasons.length === 0) {
    reasons.push('No monitoring, auto-reply, AI, or moderation capability is active.');
  }
  return { level, reasons };
}

export function groupRiskLabel(settings: GroupSettings): RiskLabelResult {
  return computeRiskLabel({
    botEnabled: settings.botEnabled,
    monitoringEnabled: settings.monitoringEnabled,
    autoReplyEnabled: settings.autoReplyEnabled,
    aiEnabled: settings.aiEnabled,
    aiAutoReplyEnabled: settings.aiAutoReplyEnabled,
    moderationEnabled: settings.moderationEnabled,
    moderationDestructiveActionsEnabled: settings.moderationDestructiveActionsEnabled,
    approvalRequired: settings.approvalRequired,
    dryRunEnabled: settings.dryRunEnabled,
  });
}

export function contactRiskLabel(settings: ContactSettings): RiskLabelResult {
  return computeRiskLabel({
    // Private contacts have no master on/off switch — automation is gated
    // directly by the individual capability toggles below.
    monitoringEnabled: settings.privateMonitoringEnabled,
    autoReplyEnabled: settings.privateAutoReplyEnabled,
    aiEnabled: settings.privateAiEnabled,
    aiAutoReplyEnabled: settings.privateAiAutoReplyEnabled,
    moderationEnabled: false,
    moderationDestructiveActionsEnabled: false,
    approvalRequired: settings.approvalRequired,
    dryRunEnabled: settings.dryRunEnabled,
  });
}

function isHumanTakeoverActive(humanTakeoverUntil: string | undefined): boolean {
  return Boolean(humanTakeoverUntil && new Date(humanTakeoverUntil).getTime() > Date.now());
}

/**
 * A plain-language "what can this bot actually do here, right now"
 * summary — the Bot Capability Preview. Deliberately built from the exact
 * same settings object the rest of the dashboard already reads (no
 * separate snapshot, nothing that can drift from reality), and computed
 * fresh on every read rather than cached, so it's always exactly as
 * current as the settings themselves.
 */
export function groupCapabilitySummary(settings: GroupSettings): string[] {
  const capabilities: string[] = [];
  if (settings.monitoringEnabled) {
    capabilities.push(
      'Stores incoming messages for this group (required for deleted-message and media archiving).',
    );
  }
  if (settings.autoReplyEnabled) {
    capabilities.push('Can send automatic replies when a rule matches.');
  }
  if (settings.aiEnabled && settings.aiAutoReplyEnabled) {
    capabilities.push('Can use AI to generate and send replies automatically.');
  } else if (settings.aiEnabled) {
    capabilities.push(
      'AI is enabled for semantic classification, but AI-generated auto-replies are off.',
    );
  }
  if (settings.moderationEnabled) {
    capabilities.push('Can warn members automatically based on moderation rules.');
  }
  if (settings.moderationDestructiveActionsEnabled) {
    capabilities.push('Can delete messages or remove members automatically.');
  }
  if (settings.deletedMessageArchiveEnabled) {
    capabilities.push('Archives "delete for everyone" messages (text) for later review.');
  }
  if (settings.viewOnceHandlingEnabled) {
    capabilities.push('Archives view-once images/videos before they disappear.');
  }
  if (settings.mediaArchiveEnabled) {
    capabilities.push(
      'Archives ordinary incoming media (images, video, audio, documents, stickers).',
    );
  }
  if (settings.approvalRequired) {
    capabilities.push('Proposed auto-replies wait for owner approval before sending.');
  }
  if (settings.quietHoursEnabled) {
    capabilities.push(
      'Quiet Hours are configured — automation pauses during the configured window.',
    );
  }
  if (isHumanTakeoverActive(settings.humanTakeoverUntil)) {
    capabilities.push(
      'Human Takeover is active — auto-reply and AI are suppressed until it expires.',
    );
  }
  if (settings.neverAutoReply) {
    capabilities.push('Never Auto Reply is on — overrides every auto-reply rule for this group.');
  }
  if (settings.neverModerate) {
    capabilities.push('Never Moderate is on — overrides every moderation rule for this group.');
  }
  if (settings.dryRunEnabled) {
    capabilities.push('Dry Run is on — matched actions are logged, never actually executed.');
  }

  const lines: string[] = [];
  if (!settings.botEnabled) {
    lines.push('Bot is off — none of the capabilities below can run until it is turned on.');
  }
  if (capabilities.length === 0) {
    lines.push(
      'Currently idle — no monitoring, auto-reply, AI, or moderation capability is active.',
    );
  }
  lines.push(...capabilities);
  return lines;
}

export function contactCapabilitySummary(settings: ContactSettings): string[] {
  const capabilities: string[] = [];
  if (settings.privateMonitoringEnabled) {
    capabilities.push(
      'Stores incoming messages for this chat (required for deleted-message/media archiving).',
    );
  }
  if (settings.privateAutoReplyEnabled) {
    capabilities.push('Can send automatic replies when a rule matches.');
  }
  if (settings.privateAiEnabled && settings.privateAiAutoReplyEnabled) {
    capabilities.push('Can use AI to generate and send replies automatically.');
  } else if (settings.privateAiEnabled) {
    capabilities.push(
      'AI is enabled for semantic classification, but AI-generated auto-replies are off.',
    );
  }
  if (settings.privateDeletedMessageArchiveEnabled) {
    capabilities.push('Archives "delete for everyone" messages (text) for later review.');
  }
  if (settings.mediaArchiveEnabled) {
    capabilities.push(
      'Archives ordinary incoming media (images, video, audio, documents, stickers).',
    );
  }
  if (settings.approvalRequired) {
    capabilities.push('Proposed auto-replies wait for owner approval before sending.');
  }
  if (settings.quietHoursEnabled) {
    capabilities.push(
      'Quiet Hours are configured — automation pauses during the configured window.',
    );
  }
  if (isHumanTakeoverActive(settings.humanTakeoverUntil)) {
    capabilities.push(
      'Human Takeover is active — auto-reply and AI are suppressed until it expires.',
    );
  }
  if (settings.neverAutoReply) {
    capabilities.push('Never Auto Reply is on — overrides every auto-reply rule for this chat.');
  }
  if (settings.dryRunEnabled) {
    capabilities.push('Dry Run is on — matched actions are logged, never actually executed.');
  }

  if (capabilities.length === 0) {
    return ['Currently idle — no monitoring, auto-reply, or AI capability is active.'];
  }
  return capabilities;
}
