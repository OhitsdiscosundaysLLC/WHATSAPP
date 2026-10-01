import type { Logger } from 'pino';
import type { AiCallContext, AIService } from '../../ai/aiService';
import { checkAiUsageAllowed } from '../../ai/aiUsagePolicy';
import type { AdminsRepository } from '../../db/adminsRepository';
import type { AiUsageRepository } from '../../db/aiUsageRepository';
import type { AuditRepository } from '../../db/auditRepository';
import type { GroupsRepository, WhatsAppGroup } from '../../db/groupsRepository';
import type { IdentityMapRepository } from '../../db/identityMapRepository';
import type { RulesRepository } from '../../db/rulesRepository';
import type { MessageSender } from '../../rules/actionEngine';
import type { NormalizedMessageEvent } from '../events/messageNormalizer';
import { resolveAuthorizedRole, type SenderIdentityCandidates } from '../identity/identityResolver';

export interface CommandHandlerDeps {
  groupsRepository: GroupsRepository;
  rulesRepository: RulesRepository;
  auditRepository: AuditRepository;
  identityMapRepository: IdentityMapRepository;
  sender: MessageSender;
  ai: { service: AIService; usageRepository: AiUsageRepository } | undefined;
  /** Digits-only numbers, as configured in OWNER_WHATSAPP_NUMBERS. The owner is always exclusively env-configured — never dashboard-manageable, so an admin can never promote themselves to owner. */
  ownerNumbers: string[];
  /** Digits-only numbers, as configured in ADMIN_WHATSAPP_NUMBERS. Merged at check-time with any dashboard-added admins from `adminsRepository`. */
  adminNumbers: string[];
  /** Optional — when provided, dashboard-managed admins (src/web/adminRoutes.ts) are merged with `adminNumbers` on every authorization check. */
  adminsRepository?: AdminsRepository;
  logger: Logger;
}

async function resolveAdminNumbers(
  accountId: string,
  deps: Pick<CommandHandlerDeps, 'adminNumbers' | 'adminsRepository'>,
): Promise<string[]> {
  if (!deps.adminsRepository) return deps.adminNumbers;
  const dbAdmins = await deps.adminsRepository.listByAccount(accountId);
  return [...deps.adminNumbers, ...dbAdmins.map((a) => a.phoneNumber)];
}

const KNOWN_COMMANDS = new Set(['bot', 'ai', 'monitor', 'rules', 'settings', 'status', 'help']);

/**
 * Owner/admin-only in-chat commands (product spec Part C). Returns `true`
 * if the message was handled as a command — the caller
 * (`src/whatsapp/events/eventPipeline.ts`) must then stop processing this
 * event any further (never also run it through rule evaluation). Returns
 * `false` for anything that isn't a recognized command from an authorized
 * sender, including a dot-prefixed message from an unauthorized
 * participant — "normal participants must not be able to enable the bot
 * or AI" (spec) is enforced by never even recognizing their message as a
 * command, not by replying with a rejection (which would itself be an
 * unrequested auto-response to an unauthorized sender).
 *
 * Commands always affect the group they were sent in (spec: "`.bot on`
 * inside Group A must enable Group A only") — this function is only ever
 * called for a `context === 'group'` event with a resolved `group`.
 *
 * `@lid` identity support: WhatsApp can present a sender as an `@lid`
 * (linked-id) JID instead of `<number>@s.whatsapp.net`. Authorization
 * tries every identity form Baileys attached to this specific message
 * (`identityCandidates` — see src/whatsapp/identity/identityResolver.ts),
 * then falls back to the durable `whatsapp_identity_map` built from past
 * messages/group-discovery. Never authorizes by display name.
 */
export async function tryHandleCommand(
  event: NormalizedMessageEvent,
  group: WhatsAppGroup,
  identityCandidates: SenderIdentityCandidates,
  deps: CommandHandlerDeps,
): Promise<boolean> {
  const text = event.text?.trim();
  if (!text || !text.startsWith('.')) return false;

  const [rawCommand, ...argWords] = text.slice(1).split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();
  if (!KNOWN_COMMANDS.has(command)) return false;

  const role = await resolveAuthorizedRole(
    identityCandidates,
    event.accountId,
    deps.identityMapRepository,
    deps.ownerNumbers,
    await resolveAdminNumbers(event.accountId, deps),
  );
  if (!role) return false; // Not from an authorized owner/admin — don't treat as a command at all.

  const argsText = argWords.join(' ').trim();
  await deps.auditRepository.recordEvent({
    accountId: event.accountId,
    groupId: group.id,
    actor: 'owner',
    eventType: 'command.executed',
    detail: { command, args: argsText, senderJid: event.senderJid, role },
  });

  switch (command) {
    case 'bot':
      await handleToggle(deps, group, event.groupJid!, argsText, 'botEnabled', 'Bot', 'bot');
      return true;
    case 'ai':
      await handleAiCommand(deps, event, group, argsText);
      return true;
    case 'monitor':
      await handleToggle(
        deps,
        group,
        event.groupJid!,
        argsText,
        'monitoringEnabled',
        'Monitoring',
        'monitor',
      );
      return true;
    case 'rules':
      await handleRules(deps, group, event.groupJid!);
      return true;
    case 'settings':
      await handleSettings(deps, group, event.groupJid!);
      return true;
    case 'status':
      await handleStatus(deps, group, event.groupJid!);
      return true;
    case 'help':
      await deps.sender.sendTextMessage(event.groupJid!, HELP_TEXT);
      return true;
    default:
      return true;
  }
}

const HELP_TEXT = [
  'Available commands (owner/admin only):',
  '.bot on|off — turn the bot on/off for this group',
  '.ai on|off — turn AI on/off for this group',
  '.ai <question> — ask AI directly (requires AI to be on)',
  '.monitor on|off — turn message monitoring on/off for this group',
  '.rules — list this group’s rules',
  '.settings — show this group’s current configuration',
  '.status — quick status summary',
  '.help — this message',
].join('\n');

async function handleToggle(
  deps: CommandHandlerDeps,
  group: WhatsAppGroup,
  groupJid: string,
  argsText: string,
  field: 'botEnabled' | 'aiEnabled' | 'monitoringEnabled',
  label: string,
  commandName: string,
): Promise<void> {
  const arg = argsText.toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await deps.sender.sendTextMessage(groupJid, `Usage: .${commandName} on|off`);
    return;
  }
  const value = arg === 'on';
  await deps.groupsRepository.updateSettings(group.id, { [field]: value });
  await deps.sender.sendTextMessage(
    groupJid,
    `${label} is now ${value ? 'ON' : 'OFF'} for this group.`,
  );
}

async function handleAiCommand(
  deps: CommandHandlerDeps,
  event: NormalizedMessageEvent,
  group: WhatsAppGroup,
  argsText: string,
): Promise<void> {
  const groupJid = event.groupJid!;
  const lower = argsText.toLowerCase();
  if (lower === 'on' || lower === 'off' || argsText === '') {
    await handleToggle(deps, group, groupJid, argsText || 'help', 'aiEnabled', 'AI', 'ai');
    return;
  }

  // Anything else is an explicit AI request: ".ai <question>" — product
  // spec Part A: "an authorized .ai command requests AI."
  const settings = await deps.groupsRepository.ensureSettings(group.id);
  if (!settings.aiEnabled) {
    await deps.sender.sendTextMessage(
      groupJid,
      'AI is not enabled for this group. Send ".ai on" first.',
    );
    return;
  }
  if (!deps.ai) {
    await deps.sender.sendTextMessage(groupJid, 'AI is not configured on this deployment.');
    return;
  }

  const permission = await checkAiUsageAllowed(
    group.id,
    {
      aiCooldownSeconds: settings.aiCooldownSeconds,
      aiMaxResponsesPerHour: settings.aiMaxResponsesPerHour,
    },
    deps.ai.usageRepository,
  );
  if (!permission.allowed) {
    await deps.sender.sendTextMessage(
      groupJid,
      `AI is temporarily unavailable: ${permission.reason}`,
    );
    return;
  }

  const ctx: AiCallContext = {
    accountId: event.accountId,
    groupId: group.id,
    contactId: undefined,
    ruleId: undefined,
    reason: 'command_ai_ask',
  };
  try {
    const ownerConfig = [settings.customGroupInstructions, settings.customAiInstructions]
      .filter(Boolean)
      .join('\n');
    const reply = await deps.ai.service.generateReply(ctx, {
      ownerConfig: ownerConfig || undefined,
      userMessage: argsText,
    });
    await deps.sender.sendTextMessage(groupJid, reply);
  } catch (err) {
    deps.logger.warn({ err, groupId: group.id }, '.ai command failed');
    await deps.sender.sendTextMessage(groupJid, 'Sorry, AI is unavailable right now.');
  }
}

async function handleRules(
  deps: CommandHandlerDeps,
  group: WhatsAppGroup,
  groupJid: string,
): Promise<void> {
  const rules = await deps.rulesRepository.listByGroup(group.id);
  if (rules.length === 0) {
    await deps.sender.sendTextMessage(groupJid, 'No rules configured for this group.');
    return;
  }
  const lines = rules.map((rule) => {
    const status = rule.enabled ? 'ON' : 'OFF';
    const threshold =
      rule.triggerType === 'response_threshold' && 'threshold' in rule.config
        ? ` (threshold ${(rule.config as { threshold: number }).threshold})`
        : '';
    return `- ${rule.name} [${status}] — ${rule.triggerType}${threshold}`;
  });
  await deps.sender.sendTextMessage(groupJid, ['Rules:', ...lines].join('\n'));
}

async function handleSettings(
  deps: CommandHandlerDeps,
  group: WhatsAppGroup,
  groupJid: string,
): Promise<void> {
  const s = await deps.groupsRepository.ensureSettings(group.id);
  const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
  const lines = [
    `Bot: ${onOff(s.botEnabled)}`,
    `Monitoring: ${onOff(s.monitoringEnabled)}`,
    `AI: ${onOff(s.aiEnabled)}`,
    `Auto Reply: ${onOff(s.autoReplyEnabled)}`,
    `Deleted Archive: ${onOff(s.deletedMessageArchiveEnabled)}`,
    `View Once: ${onOff(s.viewOnceHandlingEnabled)}`,
    `Calls: ${onOff(s.callHandlingEnabled)}`,
    `Moderation: ${onOff(s.moderationEnabled)}`,
  ];
  await deps.sender.sendTextMessage(groupJid, lines.join('\n'));
}

async function handleStatus(
  deps: CommandHandlerDeps,
  group: WhatsAppGroup,
  groupJid: string,
): Promise<void> {
  const [s, rules] = await Promise.all([
    deps.groupsRepository.ensureSettings(group.id),
    deps.rulesRepository.listByGroup(group.id),
  ]);
  const enabledRules = rules.filter((r) => r.enabled).length;
  await deps.sender.sendTextMessage(
    groupJid,
    [
      `Bot: ${s.botEnabled ? 'ON' : 'OFF'}`,
      `Monitoring: ${s.monitoringEnabled ? 'ON' : 'OFF'}`,
      `AI: ${s.aiEnabled ? 'ON' : 'OFF'}`,
      `Rules: ${enabledRules}/${rules.length} enabled`,
    ].join('\n'),
  );
}
