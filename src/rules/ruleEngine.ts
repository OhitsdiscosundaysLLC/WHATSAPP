import type { Logger } from 'pino';
import type { AuditRepository } from '../db/auditRepository';
import type { GroupRule, RulesRepository } from '../db/rulesRepository';
import type { RuleStateRepository } from '../db/ruleStateRepository';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import { executeAction, type MessageSender } from './actionEngine';
import type { ResponseClassifier } from './classifiers/responseClassifier';

export interface RuleEngineDeps {
  rulesRepository: RulesRepository;
  ruleStateRepository: RuleStateRepository;
  auditRepository: AuditRepository;
  classifier: ResponseClassifier;
  sender: MessageSender;
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

  async evaluate(event: NormalizedMessageEvent, groupId: string): Promise<void> {
    // Defense in depth — the caller (eventPipeline) is expected to have
    // already filtered to non-fromMe group messages before gating on
    // bot_enabled and calling this, but the rule engine must never fire
    // off of the bot's own message or a non-group context regardless.
    if (event.fromMe || event.context !== 'group' || !event.groupJid) return;

    const rules = await this.deps.rulesRepository.listEnabledByGroup(groupId);
    for (const rule of rules) {
      switch (rule.triggerType) {
        case 'response_threshold':
          await this.evaluateResponseThreshold(rule, event, groupId);
          break;
        default:
          this.deps.logger.warn(
            { ruleId: rule.id, triggerType: rule.triggerType },
            'Skipping rule with unsupported trigger_type',
          );
      }
    }
  }

  private async evaluateResponseThreshold(
    rule: GroupRule,
    event: NormalizedMessageEvent,
    groupId: string,
  ): Promise<void> {
    if (!event.groupJid) return; // narrows the type for TS below; evaluate() already enforces this

    const config = rule.config;
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

    const result = await executeAction(config.action, {
      groupJid,
      sender: this.deps.sender,
      ownerJids: this.deps.ownerJids,
    });

    await this.deps.ruleStateRepository.recordFired(rule.id, new Date());

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
}
