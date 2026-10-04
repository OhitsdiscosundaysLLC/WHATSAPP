import type { Logger } from 'pino';
import type { AiUsageRepository } from '../db/aiUsageRepository';
import type { AuditRepository } from '../db/auditRepository';
import type { ContactSettings } from '../db/contactsRepository';
import type { GroupSettings } from '../db/groupsRepository';
import type { ModerationStateRepository } from '../db/moderationStateRepository';
import type { OwnerInboxRepository } from '../db/ownerInboxRepository';
import type { PendingApprovalsRepository } from '../db/pendingApprovalsRepository';
import type { GroupRule, RulesRepository } from '../db/rulesRepository';
import type { RuleStateRepository } from '../db/ruleStateRepository';
import type { AiCallContext, AIService } from '../ai/aiService';
import { checkAiUsageAllowed, checkAiUsageAllowedForContact } from '../ai/aiUsagePolicy';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import { executeAction, type MessageSender } from './actionEngine';
import { classifyAutoReply } from './classifiers/autoReplyClassifier';
import type { ResponseClassifier } from './classifiers/responseClassifier';
import { isWithinQuietHours } from './quietHours';
import {
  executeModerationAction,
  type ModerationCapabilities,
} from './moderation/moderationActionEngine';
import { qualifiesForModeration } from './moderation/moderationQualifier';
import type {
  ActionConfig,
  AutoReplyConfig,
  EscalationConfig,
  ModerationActionConfig,
  ModerationConfig,
  ResponseThresholdConfig,
} from './ruleConfig';

export interface RuleEngineDeps {
  rulesRepository: RulesRepository;
  ruleStateRepository: RuleStateRepository;
  moderationStateRepository: ModerationStateRepository;
  auditRepository: AuditRepository;
  /** The human-readable "look at this" feed — see src/db/ownerInboxRepository.ts. Populated only from structured data already known at each call site, never AI-generated guessing. */
  ownerInbox: OwnerInboxRepository;
  /** "Approval Before Send" (Phase 8) — see src/db/pendingApprovalsRepository.ts. */
  pendingApprovals: PendingApprovalsRepository;
  classifier: ResponseClassifier;
  sender: MessageSender;
  moderationCapabilities: ModerationCapabilities;
  /** `undefined` when OPENAI_API_KEY isn't configured — AI-dependent branches fail closed (skip, never crash). */
  ai: { service: AIService; usageRepository: AiUsageRepository } | undefined;
  /** WhatsApp JIDs for NOTIFY_OWNER — derived from OWNER_WHATSAPP_NUMBERS. */
  ownerJids: string[];
  logger: Logger;
}

/**
 * The rule engine — "the brain of the automation" (product spec). Takes one
 * already-normalized, idempotency-checked message event and evaluates it
 * against a group's enabled rules:
 *
 *   EVENT → LOAD ENABLED RULES → EVALUATE TRIGGER/CONDITIONS → THRESHOLD/STATE
 *   → ACTION → AUDIT
 *
 * Callers (src/whatsapp/events/eventPipeline.ts) are responsible for the
 * earlier pipeline stages (dedup, group/private context, loading group
 * settings) and must only call `evaluate()` when the group's
 * `bot_enabled` is true. All state (threshold progress, distinct
 * responders, fired flag, cooldowns) lives in Supabase via the injected
 * repositories — nothing here is kept in process memory, so a restart
 * mid-threshold loses no progress (docs/DECISIONS.md ADR-012).
 *
 * Only `response_threshold` (the "N distinct people respond" rule type) is
 * implemented. Extensible: a new trigger type adds a new private
 * `evaluate<X>` method and a new branch in `evaluate()`'s dispatch — never
 * touches this class's public surface.
 */
export class RuleEngine {
  constructor(private readonly deps: RuleEngineDeps) {}

  async evaluate(
    event: NormalizedMessageEvent,
    groupId: string,
    settings: GroupSettings,
  ): Promise<void> {
    // Defense in depth — the caller (eventPipeline) is expected to have
    // already filtered to non-fromMe group messages before gating on
    // bot_enabled and calling this, but the rule engine must never fire
    // off of the bot's own message or a non-group context regardless.
    if (event.fromMe || event.context !== 'group' || !event.groupJid) return;

    const rules = await this.deps.rulesRepository.listEnabledByGroup(groupId);

    // Escalation rules run first, regardless of their position in `rules`,
    // so a `suppressAutoReply` decision is known before any auto_reply rule
    // in this same pass is dispatched — see evaluateEscalation's doc comment.
    let suppressAutoReply = false;
    for (const rule of rules) {
      if (rule.triggerType === 'escalation') {
        const suppressed = await this.evaluateEscalation(rule, event, groupId, undefined, settings);
        if (suppressed) suppressAutoReply = true;
      }
    }

    for (const rule of rules) {
      switch (rule.triggerType) {
        case 'response_threshold':
          await this.evaluateResponseThreshold(rule, event, groupId, settings);
          break;
        case 'auto_reply':
          if (!suppressAutoReply) await this.evaluateAutoReply(rule, event, groupId, settings);
          break;
        case 'moderation':
          await this.evaluateModeration(rule, event, groupId, settings);
          break;
        case 'escalation':
          break; // already handled above
        default:
          this.deps.logger.warn(
            { ruleId: rule.id, triggerType: rule.triggerType },
            'Skipping rule with unsupported trigger_type',
          );
      }
    }
  }

  /**
   * DM-side equivalent of `evaluate()` — a private chat only ever supports
   * `auto_reply` rules (no distinct-responder threshold — a DM has exactly
   * one other participant — and no moderation — there is no participant to
   * remove). Caller (eventPipeline) must only call this when the contact
   * isn't blocked; `settings.privateAutoReplyEnabled` is still re-checked
   * here as defense in depth, same pattern as the group path.
   */
  async evaluatePrivate(
    event: NormalizedMessageEvent,
    contactId: string,
    settings: ContactSettings,
  ): Promise<void> {
    if (event.fromMe || event.context !== 'private') return;

    const rules = await this.deps.rulesRepository.listEnabledByContact(contactId);

    let suppressAutoReply = false;
    for (const rule of rules) {
      if (rule.triggerType === 'escalation') {
        const suppressed = await this.evaluateEscalation(
          rule,
          event,
          undefined,
          contactId,
          settings,
        );
        if (suppressed) suppressAutoReply = true;
      }
    }

    for (const rule of rules) {
      if (rule.triggerType === 'escalation') continue; // already handled above
      if (rule.triggerType !== 'auto_reply') {
        this.deps.logger.warn(
          { ruleId: rule.id, triggerType: rule.triggerType },
          'Skipping contact rule with unsupported trigger_type',
        );
        continue;
      }
      if (!suppressAutoReply) await this.evaluateContactAutoReply(rule, event, contactId, settings);
    }
  }

  private async evaluateResponseThreshold(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    groupId: string,
    settings: GroupSettings,
  ): Promise<void> {
    if (!event.groupJid) return; // narrows the type for TS below; evaluate() already enforces this

    const config = rule.config as ResponseThresholdConfig;
    const accountId = event.accountId;
    const groupJid = event.groupJid;

    // targetMessageMatch is always 'quoted' today: a qualifying response
    // MUST be a reply to the target message — see product spec #12. A
    // message that isn't quoting anything can't be a response to this
    // rule's (as-yet-unknown) target message.
    const targetMessageId = event.quotedWhatsappMessageId;
    if (!targetMessageId) return;

    const qualifies = await this.deps.classifier.classify(event.text, config.qualify);
    if (!qualifies) return;

    const match = await this.deps.ruleStateRepository.getOrCreateMatch(rule.id, targetMessageId);
    if (match.fired) return; // already resolved for this target message — nothing more to do

    await this.deps.ruleStateRepository.addResponder(
      match.id,
      event.senderJid,
      event.whatsappMessageId,
    );
    const count = await this.deps.ruleStateRepository.countDistinctResponders(match.id);

    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId,
      eventType: 'rule.threshold_progress',
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        targetMessageId,
        distinctResponders: count,
        threshold: config.threshold,
      },
    });

    if (count < config.threshold) return;

    // Atomic compare-and-set: only the evaluation that actually flips
    // fired false -> true proceeds to execute the action. Any other
    // concurrent evaluation of the same target message (e.g. a near-
    // simultaneous 5th and 6th qualifying response) backs off here.
    const wonTheFire = await this.deps.ruleStateRepository.tryMarkFired(match.id);
    if (!wonTheFire) return;

    if (config.cooldownSeconds > 0) {
      const lastFiredAt = await this.deps.ruleStateRepository.getLastFiredAt(rule.id);
      if (lastFiredAt) {
        const elapsedSeconds = (Date.now() - lastFiredAt.getTime()) / 1000;
        if (elapsedSeconds < config.cooldownSeconds) {
          const remainingSeconds = Math.ceil(config.cooldownSeconds - elapsedSeconds);
          await this.deps.auditRepository.recordAction({
            accountId,
            groupId,
            ruleId: rule.id,
            triggerWhatsappMessageId: targetMessageId,
            actionType: config.action.type,
            status: 'skipped',
            detail: { reason: 'cooldown_active', remainingSeconds },
          });
          await this.deps.auditRepository.recordEvent({
            accountId,
            groupId,
            eventType: 'rule.fired_but_action_skipped',
            detail: {
              ruleId: rule.id,
              ruleName: rule.name,
              reason: 'cooldown_active',
              remainingSeconds,
            },
          });
          return;
        }
      }
    }

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

    if (settings.dryRunEnabled) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: targetMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'dry_run', wouldHaveActed: describeAction(config.action) },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId,
        eventType: 'rule.dry_run',
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          targetMessageId,
          distinctResponders: count,
          actionType: config.action.type,
          wouldHaveActed: describeAction(config.action),
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, groupId, targetMessageId },
        'Rule would have fired (dry run)',
      );
      return;
    }

    const result = await executeAction(config.action, {
      groupJid,
      sender: this.deps.sender,
      ownerJids: this.deps.ownerJids,
    });

    await this.deps.auditRepository.recordAction({
      accountId,
      groupId,
      ruleId: rule.id,
      triggerWhatsappMessageId: targetMessageId,
      actionType: config.action.type,
      status: result.status,
      ...(result.detail ? { detail: { message: result.detail } } : {}),
    });
    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId,
      eventType: 'rule.fired',
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        targetMessageId,
        distinctResponders: count,
        actionType: config.action.type,
        actionStatus: result.status,
      },
    });

    this.deps.logger.info(
      { ruleId: rule.id, groupId, targetMessageId, actionStatus: result.status },
      'Rule fired',
    );
  }

  /**
   * `escalation` (Phase 8): deterministic phrase matching for urgent/
   * sensitive intents (refund, complaint, legal, emergency, ...) that
   * should reach the owner rather than being auto-replied to. Works for
   * both groups and private contacts — unlike moderation, there is no
   * participant to remove and nothing group-specific about "this message
   * needs a human." Evaluated BEFORE every auto_reply rule in the same
   * message (see `evaluate()`/`evaluatePrivate()`'s two-pass dispatch), so
   * `suppressAutoReply` can actually prevent this message from also
   * triggering an auto-reply, regardless of rule ordering. Returns `true`
   * when this rule fired AND its `suppressAutoReply` is on, so the caller
   * knows to skip auto_reply dispatch for this message.
   */
  private async evaluateEscalation(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    groupId: string | undefined,
    contactId: string | undefined,
    settings: GroupSettings | ContactSettings,
  ): Promise<boolean> {
    const config = rule.config as EscalationConfig;
    const accountId = event.accountId;

    const qualifies = await this.deps.classifier.classify(event.text, config.qualify);
    if (!qualifies) return false;

    if (config.cooldownSeconds > 0) {
      const lastFiredAt = await this.deps.ruleStateRepository.getLastFiredAt(rule.id);
      if (lastFiredAt) {
        const elapsedSeconds = (Date.now() - lastFiredAt.getTime()) / 1000;
        if (elapsedSeconds < config.cooldownSeconds) {
          await this.deps.auditRepository.recordAction({
            accountId,
            groupId,
            contactId,
            ruleId: rule.id,
            triggerWhatsappMessageId: event.whatsappMessageId,
            actionType: 'LOG_ONLY',
            status: 'skipped',
            detail: { reason: 'cooldown_active' },
          });
          return false;
        }
      }
    }

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

    if (settings.dryRunEnabled) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: 'LOG_ONLY',
        status: 'skipped',
        detail: {
          reason: 'dry_run',
          wouldHaveActed: `escalate as "${config.action.category}"${config.action.suppressAutoReply ? ' and suppress auto-reply' : ''}`,
        },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId,
        contactId,
        eventType: 'escalation.dry_run',
        detail: { ruleId: rule.id, ruleName: rule.name, category: config.action.category },
      });
      this.deps.logger.info(
        { ruleId: rule.id, groupId, contactId, category: config.action.category },
        'Escalation rule would have fired (dry run)',
      );
      return false; // a dry run never actually suppresses anything real
    }

    if (config.action.notifyOwner) {
      for (const ownerJid of this.deps.ownerJids) {
        try {
          await this.deps.sender.sendTextMessage(
            ownerJid,
            `🚨 Escalation (${config.action.category}): "${event.text ?? '(no text)'}"`,
          );
        } catch (err) {
          this.deps.logger.warn({ err, ownerJid }, 'Failed to notify owner of escalation');
        }
      }
    }

    if (config.action.createInboxItem) {
      await this.deps.ownerInbox.record({
        accountId,
        ...(groupId ? { groupId } : {}),
        ...(contactId ? { contactId } : {}),
        category: 'rule_fired',
        title: `Escalation: ${config.action.category}`,
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          category: config.action.category,
          text: event.text,
          senderJid: event.senderJid,
        },
      });
    }

    await this.deps.auditRepository.recordAction({
      accountId,
      groupId,
      contactId,
      ruleId: rule.id,
      triggerWhatsappMessageId: event.whatsappMessageId,
      actionType: 'NOTIFY_OWNER',
      status: 'success',
      detail: { category: config.action.category },
    });
    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId,
      contactId,
      eventType: 'escalation.fired',
      detail: { ruleId: rule.id, ruleName: rule.name, category: config.action.category },
    });

    this.deps.logger.info(
      { ruleId: rule.id, groupId, contactId, category: config.action.category },
      'Escalation rule fired',
    );

    return config.action.suppressAutoReply;
  }

  /**
   * `auto_reply` (Phase 6+): fires immediately on each qualifying message,
   * no threshold. "Do not automatically answer every message simply
   * because Auto Reply is enabled" (product spec Part B) is enforced by
   * requiring BOTH `settings.autoReplyEnabled` AND the rule's own qualify
   * condition to match — a rule with an empty/overly broad qualify is the
   * owner's own misconfiguration, not something this method relaxes.
   * AI-powered qualification or generation additionally requires three
   * more explicit group-level gates, all independent
   * (`aiEnabled`/`aiAutoReplyEnabled`/`aiSemanticClassificationEnabled`),
   * plus the cooldown/rate-limit policy in `src/ai/aiUsagePolicy.ts` —
   * see docs/DECISIONS.md.
   */
  private async evaluateAutoReply(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    groupId: string,
    settings: GroupSettings,
  ): Promise<void> {
    if (!settings.autoReplyEnabled) return;
    if (settings.neverAutoReply) return; // owner override — wins over every auto_reply rule unconditionally
    if (!event.groupJid) return;

    const config = rule.config as AutoReplyConfig;
    const groupJid = event.groupJid;
    const accountId = event.accountId;

    const usesAi = config.qualify.classifier === 'ai' || config.action.type === 'AI_REPLY';
    if (usesAi) {
      if (
        !settings.aiEnabled ||
        !settings.aiAutoReplyEnabled ||
        !settings.aiSemanticClassificationEnabled
      ) {
        return; // Not explicitly permitted for this group — skip silently, no audit spam per message.
      }
      if (!this.deps.ai) return; // OPENAI_API_KEY not configured.

      const permission = await checkAiUsageAllowed(
        groupId,
        {
          aiCooldownSeconds: settings.aiCooldownSeconds,
          aiMaxResponsesPerHour: settings.aiMaxResponsesPerHour,
        },
        this.deps.ai.usageRepository,
      );
      if (!permission.allowed) {
        await this.deps.auditRepository.recordEvent({
          accountId,
          groupId,
          eventType: 'ai.rate_limited',
          detail: { ruleId: rule.id, ruleName: rule.name, reason: permission.reason },
        });
        return;
      }
    }

    const classifyCtx: AiCallContext = {
      accountId,
      groupId,
      contactId: undefined,
      ruleId: rule.id,
      reason: 'auto_reply_classify',
    };
    const qualifies = await classifyAutoReply(
      event.text,
      config.qualify,
      this.deps.ai?.service,
      classifyCtx,
    );
    if (!qualifies) return;

    if (
      settings.humanTakeoverUntil &&
      new Date(settings.humanTakeoverUntil).getTime() > Date.now()
    ) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'human_takeover_active', until: settings.humanTakeoverUntil },
      });
      return;
    }

    if (isWithinQuietHours(new Date(), settings)) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'quiet_hours' },
      });
      return;
    }

    if (config.cooldownSeconds > 0) {
      const lastFiredAt = await this.deps.ruleStateRepository.getLastFiredAt(rule.id);
      if (lastFiredAt) {
        const elapsedSeconds = (Date.now() - lastFiredAt.getTime()) / 1000;
        if (elapsedSeconds < config.cooldownSeconds) {
          await this.deps.auditRepository.recordAction({
            accountId,
            groupId,
            ruleId: rule.id,
            triggerWhatsappMessageId: event.whatsappMessageId,
            actionType: config.action.type,
            status: 'skipped',
            detail: { reason: 'cooldown_active' },
          });
          return;
        }
      }
    }

    let resolvedAction: ActionConfig;
    if (config.action.type === 'AI_REPLY') {
      const generateCtx: AiCallContext = {
        accountId,
        groupId,
        contactId: undefined,
        ruleId: rule.id,
        reason: 'auto_reply_generate',
      };
      try {
        const generated = await this.deps.ai!.service.generateReply(generateCtx, {
          ownerConfig: buildOwnerConfigPrompt(settings),
          userMessage: event.text ?? '',
        });
        resolvedAction = { type: 'SEND_MESSAGE', message: generated };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.deps.auditRepository.recordAction({
          accountId,
          groupId,
          ruleId: rule.id,
          triggerWhatsappMessageId: event.whatsappMessageId,
          actionType: 'AI_REPLY',
          status: 'failed',
          detail: { error: errorMessage },
        });
        await this.deps.ownerInbox.record({
          accountId,
          groupId,
          category: 'ai_failure',
          title: `AI reply generation failed in "${rule.name}"`,
          detail: { ruleId: rule.id, ruleName: rule.name, error: errorMessage },
        });
        return;
      }
    } else {
      resolvedAction = config.action;
    }

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

    if (settings.dryRunEnabled) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'dry_run', wouldHaveActed: describeAction(resolvedAction) },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId,
        eventType: 'rule.dry_run',
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          triggerType: 'auto_reply',
          actionType: config.action.type,
          wouldHaveActed: describeAction(resolvedAction),
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, groupId },
        'Auto-reply rule would have fired (dry run)',
      );
      return;
    }

    // "Approval Before Send" (Phase 8): never dispatch directly — propose
    // the message instead, surfaced in the Owner Inbox. Only an explicit
    // owner APPROVE (optionally edited) actually sends it — see
    // src/db/pendingApprovalsRepository.ts and the approve/reject routes.
    if (settings.approvalRequired) {
      const approval = await this.deps.pendingApprovals.create({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        targetChatJid: groupJid,
        proposedMessage: (resolvedAction as { message: string }).message,
      });
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'pending_approval', approvalId: approval.id },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId,
        eventType: 'approval.pending',
        detail: { ruleId: rule.id, ruleName: rule.name, approvalId: approval.id },
      });
      await this.deps.ownerInbox.record({
        accountId,
        groupId,
        category: 'pending_approval',
        title: `Reply awaiting approval: "${rule.name}"`,
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          approvalId: approval.id,
          proposedMessage: approval.proposedMessage,
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, groupId, approvalId: approval.id },
        'Auto-reply held for owner approval',
      );
      return;
    }

    const result = await executeAction(resolvedAction, {
      groupJid,
      sender: this.deps.sender,
      ownerJids: this.deps.ownerJids,
    });

    await this.deps.auditRepository.recordAction({
      accountId,
      groupId,
      ruleId: rule.id,
      triggerWhatsappMessageId: event.whatsappMessageId,
      actionType: config.action.type,
      status: result.status,
      ...(result.detail ? { detail: { message: result.detail } } : {}),
    });
    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId,
      eventType: 'rule.fired',
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        triggerType: 'auto_reply',
        actionType: config.action.type,
        actionStatus: result.status,
      },
    });

    this.deps.logger.info(
      { ruleId: rule.id, groupId, actionStatus: result.status },
      'Auto-reply rule fired',
    );
  }

  /**
   * DM-side equivalent of `evaluateAutoReply` — same three-gate AI
   * permission check (`privateAiEnabled`/`privateAutoReplyEnabled`/
   * `privateAiAutoReplyEnabled`/`privateAiSemanticClassificationEnabled`),
   * same cooldown/rate-limit policy, same classify/generate helpers, same
   * audit trail — just scoped to a contact instead of a group. Kept as a
   * separate method (rather than generalizing evaluateAutoReply) to avoid
   * any risk to the already-verified group path.
   */
  private async evaluateContactAutoReply(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    contactId: string,
    settings: ContactSettings,
  ): Promise<void> {
    if (!settings.privateAutoReplyEnabled) return;
    if (settings.neverAutoReply) return; // owner override — wins over every auto_reply rule unconditionally

    const config = rule.config as AutoReplyConfig;
    const contactJid = event.chatJid;
    const accountId = event.accountId;

    const usesAi = config.qualify.classifier === 'ai' || config.action.type === 'AI_REPLY';
    if (usesAi) {
      if (
        !settings.privateAiEnabled ||
        !settings.privateAiAutoReplyEnabled ||
        !settings.privateAiSemanticClassificationEnabled
      ) {
        return; // Not explicitly permitted for this contact — skip silently.
      }
      if (!this.deps.ai) return; // OPENAI_API_KEY not configured.

      const permission = await checkAiUsageAllowedForContact(
        contactId,
        {
          aiCooldownSeconds: settings.aiCooldownSeconds,
          aiMaxResponsesPerHour: settings.aiMaxResponsesPerHour,
        },
        this.deps.ai.usageRepository,
      );
      if (!permission.allowed) {
        await this.deps.auditRepository.recordEvent({
          accountId,
          groupId: undefined,
          contactId,
          eventType: 'ai.rate_limited',
          detail: { ruleId: rule.id, ruleName: rule.name, reason: permission.reason },
        });
        return;
      }
    }

    const classifyCtx: AiCallContext = {
      accountId,
      groupId: undefined,
      contactId,
      ruleId: rule.id,
      reason: 'private_auto_reply_classify',
    };
    const qualifies = await classifyAutoReply(
      event.text,
      config.qualify,
      this.deps.ai?.service,
      classifyCtx,
    );
    if (!qualifies) return;

    if (
      settings.humanTakeoverUntil &&
      new Date(settings.humanTakeoverUntil).getTime() > Date.now()
    ) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId: undefined,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'human_takeover_active', until: settings.humanTakeoverUntil },
      });
      return;
    }

    if (isWithinQuietHours(new Date(), settings)) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId: undefined,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'quiet_hours' },
      });
      return;
    }

    if (config.cooldownSeconds > 0) {
      const lastFiredAt = await this.deps.ruleStateRepository.getLastFiredAt(rule.id);
      if (lastFiredAt) {
        const elapsedSeconds = (Date.now() - lastFiredAt.getTime()) / 1000;
        if (elapsedSeconds < config.cooldownSeconds) {
          await this.deps.auditRepository.recordAction({
            accountId,
            groupId: undefined,
            contactId,
            ruleId: rule.id,
            triggerWhatsappMessageId: event.whatsappMessageId,
            actionType: config.action.type,
            status: 'skipped',
            detail: { reason: 'cooldown_active' },
          });
          return;
        }
      }
    }

    let resolvedAction: ActionConfig;
    if (config.action.type === 'AI_REPLY') {
      const generateCtx: AiCallContext = {
        accountId,
        groupId: undefined,
        contactId,
        ruleId: rule.id,
        reason: 'private_auto_reply_generate',
      };
      try {
        const generated = await this.deps.ai!.service.generateReply(generateCtx, {
          ownerConfig: buildOwnerConfigPromptForContact(settings),
          userMessage: event.text ?? '',
        });
        resolvedAction = { type: 'SEND_MESSAGE', message: generated };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.deps.auditRepository.recordAction({
          accountId,
          groupId: undefined,
          contactId,
          ruleId: rule.id,
          triggerWhatsappMessageId: event.whatsappMessageId,
          actionType: 'AI_REPLY',
          status: 'failed',
          detail: { error: errorMessage },
        });
        await this.deps.ownerInbox.record({
          accountId,
          contactId,
          category: 'ai_failure',
          title: `AI reply generation failed in "${rule.name}"`,
          detail: { ruleId: rule.id, ruleName: rule.name, error: errorMessage },
        });
        return;
      }
    } else {
      resolvedAction = config.action;
    }

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

    if (settings.dryRunEnabled) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId: undefined,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'dry_run', wouldHaveActed: describeAction(resolvedAction) },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId: undefined,
        contactId,
        eventType: 'rule.dry_run',
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          triggerType: 'auto_reply',
          actionType: config.action.type,
          wouldHaveActed: describeAction(resolvedAction),
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, contactId },
        'Private auto-reply rule would have fired (dry run)',
      );
      return;
    }

    if (settings.approvalRequired) {
      const approval = await this.deps.pendingApprovals.create({
        accountId,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        targetChatJid: contactJid,
        proposedMessage: (resolvedAction as { message: string }).message,
      });
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId: undefined,
        contactId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: { reason: 'pending_approval', approvalId: approval.id },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId: undefined,
        contactId,
        eventType: 'approval.pending',
        detail: { ruleId: rule.id, ruleName: rule.name, approvalId: approval.id },
      });
      await this.deps.ownerInbox.record({
        accountId,
        contactId,
        category: 'pending_approval',
        title: `Reply awaiting approval: "${rule.name}"`,
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          approvalId: approval.id,
          proposedMessage: approval.proposedMessage,
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, contactId, approvalId: approval.id },
        'Private auto-reply held for owner approval',
      );
      return;
    }

    const result = await executeAction(resolvedAction, {
      groupJid: contactJid,
      sender: this.deps.sender,
      ownerJids: this.deps.ownerJids,
    });

    await this.deps.auditRepository.recordAction({
      accountId,
      groupId: undefined,
      contactId,
      ruleId: rule.id,
      triggerWhatsappMessageId: event.whatsappMessageId,
      actionType: config.action.type,
      status: result.status,
      ...(result.detail ? { detail: { message: result.detail } } : {}),
    });
    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId: undefined,
      contactId,
      eventType: 'rule.fired',
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        triggerType: 'auto_reply',
        actionType: config.action.type,
        actionStatus: result.status,
      },
    });

    this.deps.logger.info(
      { ruleId: rule.id, contactId, actionStatus: result.status },
      'Private auto-reply rule fired',
    );
  }

  /**
   * `moderation` (Phase 6+): deterministic-only qualification (banned
   * phrases, repeated-message spam, link detection — see
   * src/rules/moderation/moderationQualifier.ts). `DELETE_MESSAGE`/
   * `REMOVE_USER` additionally require
   * `settings.moderationDestructiveActionsEnabled` — enforced inside
   * `executeModerationAction()`, not here, so the gate lives in exactly
   * one place.
   */
  private async evaluateModeration(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    groupId: string,
    settings: GroupSettings,
  ): Promise<void> {
    if (!settings.moderationEnabled) return;
    if (settings.neverModerate) return; // owner override — wins over every moderation rule unconditionally
    if (!event.groupJid) return;

    const config = rule.config as ModerationConfig;
    const groupJid = event.groupJid;
    const accountId = event.accountId;

    const qualification = await qualifiesForModeration(
      event.text,
      event.senderJid,
      rule.id,
      config.qualify,
      this.deps.moderationStateRepository,
    );
    if (!qualification.qualifies) return;

    if (config.cooldownSeconds > 0) {
      const lastFiredAt = await this.deps.ruleStateRepository.getLastFiredAt(rule.id);
      if (lastFiredAt) {
        const elapsedSeconds = (Date.now() - lastFiredAt.getTime()) / 1000;
        if (elapsedSeconds < config.cooldownSeconds) {
          await this.deps.auditRepository.recordAction({
            accountId,
            groupId,
            ruleId: rule.id,
            triggerWhatsappMessageId: event.whatsappMessageId,
            actionType: config.action.type,
            status: 'skipped',
            detail: { reason: 'cooldown_active' },
          });
          return;
        }
      }
    }

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

    if (settings.dryRunEnabled) {
      await this.deps.auditRepository.recordAction({
        accountId,
        groupId,
        ruleId: rule.id,
        triggerWhatsappMessageId: event.whatsappMessageId,
        actionType: config.action.type,
        status: 'skipped',
        detail: {
          reason: 'dry_run',
          wouldHaveActed: describeAction(config.action),
          violationType: qualification.violationType,
          ...(qualification.matchedText ? { matchedText: qualification.matchedText } : {}),
        },
      });
      await this.deps.auditRepository.recordEvent({
        accountId,
        groupId,
        eventType: 'moderation.dry_run',
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          violationType: qualification.violationType,
          actionType: config.action.type,
          wouldHaveActed: describeAction(config.action),
        },
      });
      this.deps.logger.info(
        { ruleId: rule.id, groupId, violationType: qualification.violationType },
        'Moderation rule would have fired (dry run)',
      );
      return;
    }

    const result = await executeModerationAction(config.action, {
      groupJid,
      sender: this.deps.sender,
      moderation: this.deps.moderationCapabilities,
      ownerJids: this.deps.ownerJids,
      destructiveActionsEnabled: settings.moderationDestructiveActionsEnabled,
      targetMessageKey: {
        remoteJid: groupJid,
        id: event.whatsappMessageId,
        participant: event.senderJid,
        fromMe: false,
      },
      targetSenderJid: event.senderJid,
    });

    await this.deps.auditRepository.recordAction({
      accountId,
      groupId,
      ruleId: rule.id,
      triggerWhatsappMessageId: event.whatsappMessageId,
      actionType: config.action.type,
      status: result.status,
      detail: {
        ...(result.detail ? { message: result.detail } : {}),
        violationType: qualification.violationType,
        ...(qualification.matchedText ? { matchedText: qualification.matchedText } : {}),
      },
    });
    await this.deps.auditRepository.recordEvent({
      accountId,
      groupId,
      eventType: 'moderation.fired',
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        violationType: qualification.violationType,
        actionType: config.action.type,
        actionStatus: result.status,
      },
    });
    await this.deps.ownerInbox.record({
      accountId,
      groupId,
      category: 'moderation',
      title: `Moderation rule "${rule.name}" took action (${config.action.type})`,
      detail: {
        ruleId: rule.id,
        ruleName: rule.name,
        violationType: qualification.violationType,
        actionType: config.action.type,
        actionStatus: result.status,
        ...(qualification.matchedText ? { matchedText: qualification.matchedText } : {}),
      },
    });

    this.deps.logger.info(
      {
        ruleId: rule.id,
        groupId,
        violationType: qualification.violationType,
        actionStatus: result.status,
      },
      'Moderation rule fired',
    );
  }
}

/**
 * Human-readable "what would have happened" summary for Dry Run mode's
 * audit trail — never the owner guessing from raw action JSON. See
 * docs/DECISIONS.md's Dry Run entry.
 */
function describeAction(action: ActionConfig | ModerationActionConfig): string {
  switch (action.type) {
    case 'SEND_MESSAGE':
      return `send message: "${action.message}"`;
    case 'NOTIFY_OWNER':
      return `notify owner: "${action.message}"`;
    case 'WARN':
      return `warn sender: "${action.message}"`;
    case 'DELETE_MESSAGE':
      return 'delete the message';
    case 'REMOVE_USER':
      return 'remove the sender from the group';
    case 'LOG_ONLY':
      return 'log only (no outbound action)';
    default:
      return 'take the configured action';
  }
}

/**
 * Builds the "owner configuration" portion of an AI prompt from a group's
 * settings — kept separate from the untrusted WhatsApp message at the
 * `AIProvider` layer (see src/ai/openaiProvider.ts and docs/SECURITY.md).
 */
function buildOwnerConfigPrompt(settings: GroupSettings): string | undefined {
  const parts: string[] = [];
  if (settings.customGroupInstructions) {
    parts.push(`Group context: ${settings.customGroupInstructions}`);
  }
  if (settings.customAiInstructions) {
    parts.push(`AI instructions: ${settings.customAiInstructions}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Same as buildOwnerConfigPrompt, for a private contact's settings. */
function buildOwnerConfigPromptForContact(settings: ContactSettings): string | undefined {
  const parts: string[] = [];
  if (settings.customInstructions) {
    parts.push(`Contact context: ${settings.customInstructions}`);
  }
  if (settings.customAiInstructions) {
    parts.push(`AI instructions: ${settings.customAiInstructions}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}
