import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { RecordActionInput, RecordAuditInput } from '../db/auditRepository';
import { AuditRepository } from '../db/auditRepository';
import { ContactsRepository, type ContactSettings } from '../db/contactsRepository';
import { GroupsRepository, type GroupSettings } from '../db/groupsRepository';
import { ModerationStateRepository } from '../db/moderationStateRepository';
import type { RecordInboxItemInput } from '../db/ownerInboxRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import type { CreatePendingApprovalInput } from '../db/pendingApprovalsRepository';
import { PendingApprovalsRepository } from '../db/pendingApprovalsRepository';
import { RulesRepository, type GroupRule } from '../db/rulesRepository';
import { RuleStateRepository, type RuleMatch } from '../db/ruleStateRepository';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import { DeterministicResponseClassifier } from './classifiers/responseClassifier';
import { RuleEngine } from './ruleEngine';
import type { AutoReplyConfig } from './ruleConfig';

export interface SimulateMessageInput {
  groupId?: string;
  contactId?: string;
  senderJid: string;
  text: string;
  messageType?: string;
  quotedWhatsappMessageId?: string;
  quotedParticipant?: string;
  /** ISO timestamp — defaults to now. Informational only (no rule currently reads it directly; quiet hours/human takeover use the real clock). */
  timestamp?: string;
}

export interface SimulatedRuleResult {
  ruleId: string;
  ruleName: string;
  triggerType: string;
  enabled: boolean;
  /** 'ai_not_simulated' when the rule needs a live AI call — see its `reason`. */
  matched: 'yes' | 'no' | 'ai_not_simulated';
  reason: string;
  /** The exact action that would have executed, in human-readable form — see `describeAction()` in ruleEngine.ts. */
  wouldHaveActed: string | undefined;
  qualify: unknown;
  distinctResponders: number | undefined;
  threshold: number | undefined;
}

export interface SimulationOutcome {
  event: NormalizedMessageEvent;
  /** Facts about the current configuration that silently suppress every rule of a kind, so a "no match" isn't mistaken for "this rule's condition failed." */
  notes: string[];
  rules: SimulatedRuleResult[];
}

/**
 * The qualify/action shape is identical across response_threshold, auto_reply,
 * moderation, and escalation configs (each has `.qualify`) — this reads it
 * generically rather than re-deriving per trigger type.
 */
function qualifyOf(rule: GroupRule): unknown {
  return (rule.config as { qualify?: unknown }).qualify;
}

function requiresAi(rule: GroupRule): boolean {
  if (rule.triggerType !== 'auto_reply') return false;
  const config = rule.config as AutoReplyConfig;
  return config.qualify.classifier === 'ai' || config.action.type === 'AI_REPLY';
}

/** Same real DB reads as RulesRepository — filters out AI-dependent rules so the simulation engine pass never attempts one (see the module doc comment). */
class NonAiRulesRepository extends RulesRepository {
  override async listEnabledByGroup(groupId: string): Promise<GroupRule[]> {
    return (await super.listEnabledByGroup(groupId)).filter((r) => !requiresAi(r));
  }
  override async listEnabledByContact(contactId: string): Promise<GroupRule[]> {
    return (await super.listEnabledByContact(contactId)).filter((r) => !requiresAi(r));
  }
}

/**
 * In-memory, per-simulation-call only — never touches `rule_matches`/
 * `rule_match_responders`/`rule_cooldowns`. Always starts fresh (no cooldown,
 * no existing responders), since a simulation tests a scenario the owner
 * constructs, not a replay against live production counters — see
 * docs/DECISIONS.md.
 */
class SimulatedRuleStateRepository extends RuleStateRepository {
  private readonly matches = new Map<string, RuleMatch & { responders: Set<string> }>();

  constructor() {
    super({} as unknown as SupabaseClient);
  }

  override async getOrCreateMatch(
    ruleId: string,
    targetWhatsappMessageId: string,
  ): Promise<RuleMatch> {
    const key = `${ruleId}:${targetWhatsappMessageId}`;
    const existing = this.matches.get(key);
    if (existing) return existing;
    const created = {
      id: key,
      ruleId,
      targetWhatsappMessageId,
      fired: false,
      firedAt: undefined,
      responders: new Set<string>(),
    };
    this.matches.set(key, created);
    return created;
  }

  override async addResponder(ruleMatchId: string, senderJid: string): Promise<void> {
    this.matches.get(ruleMatchId)?.responders.add(senderJid);
  }

  override async countDistinctResponders(ruleMatchId: string): Promise<number> {
    return this.matches.get(ruleMatchId)?.responders.size ?? 0;
  }

  override async tryMarkFired(ruleMatchId: string): Promise<boolean> {
    const match = this.matches.get(ruleMatchId);
    if (!match || match.fired) return false;
    match.fired = true;
    return true;
  }

  override async getLastFiredAt(_ruleId: string): Promise<Date | undefined> {
    return undefined; // always "no cooldown active" — see class doc comment
  }

  override async recordFired(): Promise<void> {
    // discarded — see class doc comment
  }
}

class SimulatedModerationStateRepository extends ModerationStateRepository {
  private readonly counts = new Map<string, number>();

  constructor() {
    super({} as unknown as SupabaseClient);
  }

  override async recordAndCount(ruleId: string, senderJid: string): Promise<number> {
    const key = `${ruleId}:${senderJid}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

/** Captures what WOULD have been recorded — never writes to `bot_actions`/`whatsapp_audit_logs`. */
class CapturingAuditRepository extends AuditRepository {
  readonly actions: RecordActionInput[] = [];
  readonly events: RecordAuditInput[] = [];

  constructor() {
    super({} as unknown as SupabaseClient);
  }

  override async recordAction(input: RecordActionInput): Promise<void> {
    this.actions.push(input);
  }

  override async recordEvent(input: RecordAuditInput): Promise<void> {
    this.events.push(input);
  }
}

/** Captures what WOULD have appeared in the Owner Inbox — never writes to `owner_inbox_items`. */
class CapturingOwnerInboxRepository extends OwnerInboxRepository {
  readonly items: RecordInboxItemInput[] = [];

  constructor() {
    super({} as unknown as SupabaseClient);
  }

  override async record(input: RecordInboxItemInput): Promise<void> {
    this.items.push(input);
  }
}

/** Captures what WOULD have been proposed for approval — never writes to `pending_approvals`. */
class CapturingPendingApprovalsRepository extends PendingApprovalsRepository {
  readonly proposed: CreatePendingApprovalInput[] = [];

  constructor() {
    super({} as unknown as SupabaseClient);
  }

  override async create(input: CreatePendingApprovalInput) {
    this.proposed.push(input);
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      accountId: input.accountId,
      groupId: input.groupId,
      contactId: input.contactId,
      ruleId: input.ruleId,
      triggerWhatsappMessageId: input.triggerWhatsappMessageId,
      targetChatJid: input.targetChatJid,
      proposedMessage: input.proposedMessage,
      status: 'pending' as const,
      decidedBy: undefined,
      decidedAt: undefined,
      createdAt: now,
    };
  }
}

function reasonFromDetail(detail: Record<string, unknown> | undefined): {
  reasonCode: string | undefined;
  wouldHaveActed: string | undefined;
} {
  const reasonCode = typeof detail?.reason === 'string' ? detail.reason : undefined;
  const wouldHaveActed =
    typeof detail?.wouldHaveActed === 'string' ? detail.wouldHaveActed : undefined;
  return { reasonCode, wouldHaveActed };
}

function describeReasonCode(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case 'dry_run':
      return 'Qualifies.';
    case 'cooldown_active':
      return 'Qualifies, but its cooldown would currently suppress it.';
    case 'human_takeover_active':
      return 'Qualifies, but Human Takeover is currently active, suppressing it.';
    case 'quiet_hours':
      return 'Qualifies, but Quiet Hours is currently active, suppressing it.';
    case 'pending_approval':
      return 'Qualifies — would be held for owner approval instead of sending directly.';
    default:
      return 'Qualifies.';
  }
}

/**
 * Simulates how the REAL rule engine (src/rules/ruleEngine.ts, the same
 * class and the same `evaluate()`/`evaluatePrivate()` methods production
 * uses) would handle one hypothetical incoming message — without ever
 * sending a WhatsApp message, deleting one, removing a participant,
 * notifying the owner for real, or persisting any state. Two safety
 * mechanisms, both already-proven production code paths rather than a
 * second, parallel implementation:
 *
 *  1. The settings snapshot passed to the engine always has `dryRunEnabled`
 *     forced to `true`, so every dispatch point's pre-existing "never
 *     actually send/delete/remove/dispatch, just record what would have
 *     happened" branch is what runs.
 *  2. Every stateful dependency (cooldowns, threshold progress, audit log,
 *     Owner Inbox, pending approvals) is backed by an in-memory, per-call
 *     instance — nothing is read from or written to the real tables
 *     (except the group/contact's rules and settings themselves, which are
 *     read-only, so the simulation reflects the real current configuration).
 *     AI-dependent rules (`classifier: 'ai'` or `action.type: 'AI_REPLY'`)
 *     are never run through the engine at all — real AI usage costs real
 *     money, so this reports them as `ai_not_simulated` instead of making a
 *     live OpenAI call.
 */
export async function simulateMessage(
  supabase: SupabaseClient,
  ownerJids: string[],
  logger: Logger,
  input: SimulateMessageInput,
): Promise<SimulationOutcome> {
  if (!input.groupId === !input.contactId) {
    throw new Error('Provide exactly one of groupId or contactId.');
  }
  if (!input.senderJid.trim()) {
    throw new Error('senderJid is required.');
  }

  const notes: string[] = [];
  let accountId: string;
  let chatJid: string;
  let groupSettings: GroupSettings | undefined;
  let contactSettings: ContactSettings | undefined;

  if (input.groupId) {
    const groupsRepository = new GroupsRepository(supabase);
    const group = await groupsRepository.getById(input.groupId);
    if (!group) throw new Error(`Group not found: ${input.groupId}`);
    accountId = group.accountId;
    chatJid = group.whatsappGroupJid;
    groupSettings = await groupsRepository.ensureSettings(input.groupId);
    if (!groupSettings.botEnabled) {
      notes.push('The Bot master switch is OFF for this group — no rule would evaluate at all.');
    }
    if (!groupSettings.autoReplyEnabled) {
      notes.push(
        'Auto-Reply is OFF for this group — no auto_reply rule would fire regardless of matching.',
      );
    }
    if (groupSettings.neverAutoReply) {
      notes.push(
        '"Never Auto Reply" is ON for this group — every auto_reply rule is suppressed regardless of matching.',
      );
    }
    if (!groupSettings.moderationEnabled) {
      notes.push(
        'Moderation is OFF for this group — no moderation rule would fire regardless of matching.',
      );
    }
    if (groupSettings.neverModerate) {
      notes.push(
        '"Never Moderate" is ON for this group — every moderation rule is suppressed regardless of matching.',
      );
    }
  } else {
    const contactsRepository = new ContactsRepository(supabase);
    const contact = await contactsRepository.getById(input.contactId!);
    if (!contact) throw new Error(`Contact not found: ${input.contactId}`);
    accountId = contact.accountId;
    chatJid = contact.whatsappJid;
    contactSettings = await contactsRepository.ensureSettings(input.contactId!);
    if (!contactSettings.privateAutoReplyEnabled) {
      notes.push(
        'Auto-Reply is OFF for this contact — no auto_reply rule would fire regardless of matching.',
      );
    }
    if (contactSettings.neverAutoReply) {
      notes.push(
        '"Never Auto Reply" is ON for this contact — every auto_reply rule is suppressed regardless of matching.',
      );
    }
  }

  const event: NormalizedMessageEvent = {
    accountId,
    chatJid,
    context: input.groupId ? 'group' : 'private',
    groupJid: input.groupId ? chatJid : undefined,
    whatsappMessageId: `SIM-${randomUUID()}`,
    senderJid: input.senderJid,
    fromMe: false,
    timestamp: input.timestamp ?? new Date().toISOString(),
    messageType: input.messageType ?? 'conversation',
    text: input.text,
    quotedWhatsappMessageId: input.quotedWhatsappMessageId,
    quotedParticipant: input.quotedParticipant,
  };

  const realRulesRepository = new RulesRepository(supabase);
  const allRules = input.groupId
    ? await realRulesRepository.listEnabledByGroup(input.groupId)
    : await realRulesRepository.listEnabledByContact(input.contactId!);

  if (allRules.length === 0) {
    notes.push('No enabled rules are configured here yet.');
  }
  if (input.groupId && !input.quotedWhatsappMessageId) {
    notes.push(
      '"Quoted message ID" is empty — response_threshold rules only evaluate replies that quote a target message, so none can match this simulation.',
    );
  }

  const auditRepository = new CapturingAuditRepository();
  const ownerInbox = new CapturingOwnerInboxRepository();
  const pendingApprovals = new CapturingPendingApprovalsRepository();
  const noopSender = { sendTextMessage: async () => {} };
  const noopModeration = { deleteMessage: async () => {}, removeParticipant: async () => {} };

  const engine = new RuleEngine({
    rulesRepository: new NonAiRulesRepository(supabase),
    ruleStateRepository: new SimulatedRuleStateRepository(),
    moderationStateRepository: new SimulatedModerationStateRepository(),
    auditRepository,
    ownerInbox,
    pendingApprovals,
    classifier: new DeterministicResponseClassifier(),
    sender: noopSender,
    moderationCapabilities: noopModeration,
    ai: undefined, // never a real AI call during simulation — see module doc comment
    ownerJids,
    logger,
  });

  if (input.groupId) {
    await engine.evaluate(event, input.groupId, { ...groupSettings!, dryRunEnabled: true });
  } else {
    await engine.evaluatePrivate(event, input.contactId!, {
      ...contactSettings!,
      dryRunEnabled: true,
    });
  }

  const actionsByRuleId = new Map<string, RecordActionInput[]>();
  for (const action of auditRepository.actions) {
    if (!action.ruleId) continue;
    const list = actionsByRuleId.get(action.ruleId) ?? [];
    list.push(action);
    actionsByRuleId.set(action.ruleId, list);
  }
  const progressByRuleId = new Map<string, { distinctResponders: number; threshold: number }>();
  for (const event_ of auditRepository.events) {
    if (event_.eventType !== 'rule.threshold_progress') continue;
    const detail = event_.detail as
      { ruleId?: string; distinctResponders?: number; threshold?: number } | undefined;
    if (
      detail?.ruleId &&
      typeof detail.distinctResponders === 'number' &&
      typeof detail.threshold === 'number'
    ) {
      progressByRuleId.set(detail.ruleId, {
        distinctResponders: detail.distinctResponders,
        threshold: detail.threshold,
      });
    }
  }

  const results: SimulatedRuleResult[] = allRules.map((rule) => {
    const progress = progressByRuleId.get(rule.id);
    if (requiresAi(rule)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        triggerType: rule.triggerType,
        enabled: rule.enabled,
        matched: 'ai_not_simulated',
        reason:
          'This rule requires a live AI call (AI-based qualification or an AI-generated reply). The simulator never calls the real AI service, to avoid real API cost — verify it with Dry Run in production instead.',
        wouldHaveActed: undefined,
        qualify: qualifyOf(rule),
        distinctResponders: progress?.distinctResponders,
        threshold: progress?.threshold,
      };
    }

    const actionsForRule = actionsByRuleId.get(rule.id) ?? [];
    if (actionsForRule.length === 0) {
      // response_threshold records progress (distinct responders so far)
      // every time the message qualifies, even when it doesn't reach the
      // threshold yet — that's still a match, just one that wouldn't fire
      // *this* message.
      if (progress) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          triggerType: rule.triggerType,
          enabled: rule.enabled,
          matched: 'yes',
          reason: `Qualifies — ${progress.distinctResponders} of ${progress.threshold} required distinct responses so far; the action would only fire once the threshold is reached.`,
          wouldHaveActed: undefined,
          qualify: qualifyOf(rule),
          distinctResponders: progress.distinctResponders,
          threshold: progress.threshold,
        };
      }
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        triggerType: rule.triggerType,
        enabled: rule.enabled,
        matched: 'no',
        reason:
          "This rule's qualifying condition did not match this message (or a silent override above suppressed it).",
        wouldHaveActed: undefined,
        qualify: qualifyOf(rule),
        distinctResponders: undefined,
        threshold: undefined,
      };
    }

    const last = actionsForRule[actionsForRule.length - 1]!;
    const { reasonCode, wouldHaveActed } = reasonFromDetail(last.detail);
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      triggerType: rule.triggerType,
      enabled: rule.enabled,
      matched: 'yes',
      reason: describeReasonCode(reasonCode),
      wouldHaveActed,
      qualify: qualifyOf(rule),
      distinctResponders: progress?.distinctResponders,
      threshold: progress?.threshold,
    };
  });

  return { event, notes, rules: results };
}
