import type { Logger } from 'pino';
import type { AiCallContext, AIService } from '../../ai/aiService';
import { checkAiUsageAllowedForContact } from '../../ai/aiUsagePolicy';
import type { AdminsRepository } from '../../db/adminsRepository';
import type { AiUsageRepository } from '../../db/aiUsageRepository';
import type { AuditRepository } from '../../db/auditRepository';
import type { ContactsRepository, WhatsAppContact } from '../../db/contactsRepository';
import type { IdentityMapRepository } from '../../db/identityMapRepository';
import type { RulesRepository } from '../../db/rulesRepository';
import type { MessageSender } from '../../rules/actionEngine';
import type { NormalizedMessageEvent } from '../events/messageNormalizer';
import { resolveAuthorizedRole, type SenderIdentityCandidates } from '../identity/identityResolver';

export interface PrivateCommandHandlerDeps {
  contactsRepository: ContactsRepository;
  rulesRepository: RulesRepository;
  auditRepository: AuditRepository;
  identityMapRepository: IdentityMapRepository;
  sender: MessageSender;
  ai: { service: AIService; usageRepository: AiUsageRepository } | undefined;
  ownerNumbers: string[];
  adminNumbers: string[];
  /** Optional — when provided, dashboard-managed admins are merged with `adminNumbers` on every authorization check. */
  adminsRepository?: AdminsRepository;
  logger: Logger;
}

async function resolveAdminNumbers(
  accountId: string,
  deps: Pick<PrivateCommandHandlerDeps, 'adminNumbers' | 'adminsRepository'>,
): Promise<string[]> {
  if (!deps.adminsRepository) return deps.adminNumbers;
  const dbAdmins = await deps.adminsRepository.listByAccount(accountId);
  return [...deps.adminNumbers, ...dbAdmins.map((a) => a.phoneNumber)];
}

const KNOWN_PRIVATE_COMMANDS = new Set(['ai', 'monitor', 'autoreply', 'status', 'help']);

/**
 * Owner/admin-only in-chat commands sent as a DM to the bot's own number —
 * "owner/admin special handling" for private chats (product spec, this
 * pass). Authorization goes through the exact same
 * `resolveAuthorizedRole()` gate as group commands, so a random person
 * DMing the bot can never configure anything for themselves: only a
 * message FROM a configured owner/admin number is ever recognized as a
 * command at all (everyone else's ".ai on" is just an ordinary message,
 * normalized/stored/evaluated like any other).
 *
 * Deliberately a smaller command set than group commands — there is no
 * `.bot`/`.rules add` here: a DM has no distinct-responder threshold or
 * moderation concept, and rule authoring stays a dashboard-only action
 * (product spec Part C: "do NOT build arbitrary executable-code rules").
 */
export async function tryHandlePrivateCommand(
  event: NormalizedMessageEvent,
  contact: WhatsAppContact,
  identityCandidates: SenderIdentityCandidates,
  deps: PrivateCommandHandlerDeps,
): Promise<boolean> {
  const text = event.text?.trim();
  if (!text || !text.startsWith('.')) return false;

  const [rawCommand, ...argWords] = text.slice(1).split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();
  if (!KNOWN_PRIVATE_COMMANDS.has(command)) return false;

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
    groupId: undefined,
    contactId: contact.id,
    actor: 'owner',
    eventType: 'command.executed',
    detail: { command, args: argsText, senderJid: event.senderJid, role, scope: 'private' },
  });

  const chatJid = event.chatJid;
  switch (command) {
    case 'ai':
      await handleAiCommand(deps, event, contact, argsText);
      return true;
    case 'monitor':
      await handleToggle(
        deps,
        contact,
        chatJid,
        argsText,
        'privateMonitoringEnabled',
        'Monitoring',
      );
      return true;
    case 'autoreply':
      await handleToggle(deps, contact, chatJid, argsText, 'privateAutoReplyEnabled', 'Auto Reply');
      return true;
    case 'status':
      await handleStatus(deps, contact, chatJid);
      return true;
    case 'help':
      await deps.sender.sendTextMessage(chatJid, HELP_TEXT);
      return true;
    default:
      return true;
  }
}

const HELP_TEXT = [
  'Available private-chat commands (owner/admin only):',
  '.ai on|off — turn private AI on/off for this chat',
  '.ai <question> — ask AI directly (requires AI to be on)',
  '.monitor on|off — turn private message monitoring on/off for this chat',
  '.autoreply on|off — turn private auto-reply on/off for this chat',
  '.status — quick status summary',
  '.help — this message',
].join('\n');

type ToggleField = 'privateMonitoringEnabled' | 'privateAutoReplyEnabled' | 'privateAiEnabled';

async function handleToggle(
  deps: PrivateCommandHandlerDeps,
  contact: WhatsAppContact,
  chatJid: string,
  argsText: string,
  field: ToggleField,
  label: string,
): Promise<void> {
  const arg = argsText.toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await deps.sender.sendTextMessage(chatJid, `Usage: .${fieldToCommand(field)} on|off`);
    return;
  }
  const value = arg === 'on';
  await deps.contactsRepository.updateSettings(contact.id, { [field]: value });
  await deps.sender.sendTextMessage(
    chatJid,
    `${label} is now ${value ? 'ON' : 'OFF'} for this chat.`,
  );
}

function fieldToCommand(field: ToggleField): string {
  switch (field) {
    case 'privateMonitoringEnabled':
      return 'monitor';
    case 'privateAutoReplyEnabled':
      return 'autoreply';
    case 'privateAiEnabled':
      return 'ai';
  }
}

async function handleAiCommand(
  deps: PrivateCommandHandlerDeps,
  event: NormalizedMessageEvent,
  contact: WhatsAppContact,
  argsText: string,
): Promise<void> {
  const chatJid = event.chatJid;
  const lower = argsText.toLowerCase();
  if (lower === 'on' || lower === 'off' || argsText === '') {
    await handleToggle(deps, contact, chatJid, argsText || 'help', 'privateAiEnabled', 'AI');
    return;
  }

  // Anything else is an explicit AI request: ".ai <question>".
  const settings = await deps.contactsRepository.ensureSettings(contact.id);
  if (!settings.privateAiEnabled) {
    await deps.sender.sendTextMessage(
      chatJid,
      'AI is not enabled for this chat. Send ".ai on" first.',
    );
    return;
  }
  if (!deps.ai) {
    await deps.sender.sendTextMessage(chatJid, 'AI is not configured on this deployment.');
    return;
  }

  const permission = await checkAiUsageAllowedForContact(
    contact.id,
    {
      aiCooldownSeconds: settings.aiCooldownSeconds,
      aiMaxResponsesPerHour: settings.aiMaxResponsesPerHour,
    },
    deps.ai.usageRepository,
  );
  if (!permission.allowed) {
    await deps.sender.sendTextMessage(
      chatJid,
      `AI is temporarily unavailable: ${permission.reason}`,
    );
    return;
  }

  const ctx: AiCallContext = {
    accountId: event.accountId,
    groupId: undefined,
    contactId: contact.id,
    ruleId: undefined,
    reason: 'private_command_ai_ask',
  };
  try {
    const ownerConfig = [settings.customInstructions, settings.customAiInstructions]
      .filter(Boolean)
      .join('\n');
    const reply = await deps.ai.service.generateReply(ctx, {
      ownerConfig: ownerConfig || undefined,
      userMessage: argsText,
    });
    await deps.sender.sendTextMessage(chatJid, reply);
  } catch (err) {
    deps.logger.warn({ err, contactId: contact.id }, '.ai command failed (private)');
    await deps.sender.sendTextMessage(chatJid, 'Sorry, AI is unavailable right now.');
  }
}

async function handleStatus(
  deps: PrivateCommandHandlerDeps,
  contact: WhatsAppContact,
  chatJid: string,
): Promise<void> {
  const [s, rules] = await Promise.all([
    deps.contactsRepository.ensureSettings(contact.id),
    deps.rulesRepository.listByContact(contact.id),
  ]);
  const enabledRules = rules.filter((r) => r.enabled).length;
  await deps.sender.sendTextMessage(
    chatJid,
    [
      `Monitoring: ${s.privateMonitoringEnabled ? 'ON' : 'OFF'}`,
      `AI: ${s.privateAiEnabled ? 'ON' : 'OFF'}`,
      `Auto Reply: ${s.privateAutoReplyEnabled ? 'ON' : 'OFF'}`,
      `Rules: ${enabledRules}/${rules.length} enabled`,
    ].join('\n'),
  );
}
