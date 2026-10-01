import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import {
  DELETED_MESSAGE_ALERT_MODES,
  GroupsRepository,
  type DeletedMessageAlertMode,
  type GroupSettingsPatch,
} from '../db/groupsRepository';
import { MediaArchiveRepository } from '../db/mediaArchiveRepository';
import { MessagesRepository } from '../db/messagesRepository';
import { RulesRepository } from '../db/rulesRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { TRIGGER_TYPES } from '../rules/ruleConfig';
import { createChildLogger } from '../services/logger';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const log = createChildLogger('web:groups');

const MATCH_MODES = ['contains', 'exact', 'keyword_any'] as const;
const ACTION_TYPES = ['SEND_MESSAGE', 'NOTIFY_OWNER', 'LOG_ONLY'] as const;
const AUTO_REPLY_ACTION_TYPES = ['SEND_MESSAGE', 'AI_REPLY'] as const;
const MODERATION_ACTION_TYPES = [
  'LOG_ONLY',
  'WARN',
  'NOTIFY_OWNER',
  'DELETE_MESSAGE',
  'REMOVE_USER',
] as const;

/** Friendly shape the dashboard's rule builder forms submit — no raw JSON required. */
interface RuleFormInput {
  name?: unknown;
  triggerType?: unknown;
  // response_threshold / auto_reply (deterministic)
  phrases?: unknown;
  matchMode?: unknown;
  // auto_reply AI classifier
  classifier?: unknown;
  aiInstructions?: unknown;
  // response_threshold only
  threshold?: unknown;
  cooldownSeconds?: unknown;
  actionType?: unknown;
  message?: unknown;
  enabled?: unknown;
  // moderation
  bannedPhrases?: unknown;
  spamRepeatThreshold?: unknown;
  spamWindowSeconds?: unknown;
  detectLinks?: unknown;
}

function ruleFormToConfig(body: RuleFormInput): unknown {
  const phrases = Array.isArray(body.phrases)
    ? body.phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const matchMode = MATCH_MODES.includes(body.matchMode as (typeof MATCH_MODES)[number])
    ? body.matchMode
    : 'contains';
  const actionType = ACTION_TYPES.includes(body.actionType as (typeof ACTION_TYPES)[number])
    ? body.actionType
    : 'SEND_MESSAGE';
  const message = typeof body.message === 'string' ? body.message : '';

  const action = actionType === 'LOG_ONLY' ? { type: 'LOG_ONLY' } : { type: actionType, message };

  return {
    targetMessageMatch: 'quoted',
    qualify: { mode: matchMode, phrases },
    threshold: Number(body.threshold),
    action,
    cooldownSeconds: Number(body.cooldownSeconds ?? 0),
  };
}

function autoReplyFormToConfig(body: RuleFormInput): unknown {
  const useAi = body.classifier === 'ai';
  const phrases = Array.isArray(body.phrases)
    ? body.phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const matchMode = MATCH_MODES.includes(body.matchMode as (typeof MATCH_MODES)[number])
    ? body.matchMode
    : 'contains';
  const qualify = useAi
    ? {
        classifier: 'ai',
        aiInstructions: typeof body.aiInstructions === 'string' ? body.aiInstructions : '',
      }
    : { classifier: 'deterministic', mode: matchMode, phrases };

  const actionType = AUTO_REPLY_ACTION_TYPES.includes(
    body.actionType as (typeof AUTO_REPLY_ACTION_TYPES)[number],
  )
    ? body.actionType
    : 'SEND_MESSAGE';
  const action =
    actionType === 'AI_REPLY'
      ? { type: 'AI_REPLY' }
      : { type: 'SEND_MESSAGE', message: typeof body.message === 'string' ? body.message : '' };

  return { qualify, action, cooldownSeconds: Number(body.cooldownSeconds ?? 0) };
}

function moderationFormToConfig(body: RuleFormInput): unknown {
  const bannedPhrases = Array.isArray(body.bannedPhrases)
    ? body.bannedPhrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const actionType = MODERATION_ACTION_TYPES.includes(
    body.actionType as (typeof MODERATION_ACTION_TYPES)[number],
  )
    ? body.actionType
    : 'LOG_ONLY';
  const action =
    actionType === 'WARN' || actionType === 'NOTIFY_OWNER'
      ? { type: actionType, message: typeof body.message === 'string' ? body.message : '' }
      : { type: actionType };

  return {
    qualify: {
      bannedPhrases,
      spamRepeatThreshold: Number(body.spamRepeatThreshold ?? 0),
      spamWindowSeconds: Number(body.spamWindowSeconds ?? 30),
      detectLinks: Boolean(body.detectLinks),
    },
    action,
    cooldownSeconds: Number(body.cooldownSeconds ?? 0),
  };
}

function formToConfig(triggerType: string, body: RuleFormInput): unknown {
  switch (triggerType) {
    case 'auto_reply':
      return autoReplyFormToConfig(body);
    case 'moderation':
      return moderationFormToConfig(body);
    case 'response_threshold':
    default:
      return ruleFormToConfig(body);
  }
}

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message:
        'Groups, monitoring, and rules require Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

export function createGroupRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (_req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const accounts = new Map(accountManager.listAccounts().map((a) => [a.id, a.label]));
    const groups = await groupsRepository.listAll();

    const payload = await Promise.all(
      groups.map(async (group) => {
        const [settings, rules] = await Promise.all([
          groupsRepository.ensureSettings(group.id),
          rulesRepository.listByGroup(group.id),
        ]);
        return {
          id: group.id,
          accountId: group.accountId,
          accountLabel: accounts.get(group.accountId) ?? 'Unknown account',
          whatsappGroupJid: group.whatsappGroupJid,
          subject: group.subject,
          discoveredAt: group.discoveredAt,
          botEnabled: settings.botEnabled,
          monitoringEnabled: settings.monitoringEnabled,
          aiEnabled: settings.aiEnabled,
          ruleCount: rules.length,
        };
      }),
    );

    res.status(200).json({ groups: payload });
  });

  router.get('/:id', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);

    const group = await groupsRepository.getById(id);
    if (!group) {
      res.status(404).json({ error: 'group_not_found' });
      return;
    }
    const settings = await groupsRepository.ensureSettings(id);
    const accountLabel =
      accountManager.listAccounts().find((a) => a.id === group.accountId)?.label ??
      'Unknown account';

    res.status(200).json({ group: { ...group, accountLabel }, settings });
  });

  router.patch('/:id/settings', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);

    const group = await groupsRepository.getById(id);
    if (!group) {
      res.status(404).json({ error: 'group_not_found' });
      return;
    }

    const body = req.body as Partial<GroupSettingsPatch> | undefined;
    const patch: GroupSettingsPatch = {};
    if (typeof body?.botEnabled === 'boolean') patch.botEnabled = body.botEnabled;
    if (typeof body?.monitoringEnabled === 'boolean')
      patch.monitoringEnabled = body.monitoringEnabled;
    if (typeof body?.customGroupInstructions === 'string') {
      patch.customGroupInstructions = body.customGroupInstructions;
    }
    if (typeof body?.defaultCooldownSeconds === 'number') {
      patch.defaultCooldownSeconds = body.defaultCooldownSeconds;
    }
    // aiEnabled / autoReplyEnabled / deletedMessageArchiveEnabled /
    // viewOnceHandlingEnabled / moderationEnabled are all functional as of
    // Phase 6+ (see src/rules/ruleEngine.ts, src/whatsapp/archive/).
    // callHandlingEnabled is accepted here for backward compatibility but
    // is NOT read by any behavior — call handling is configured per
    // ACCOUNT, not per group (see GET/PATCH /api/accounts/:id/call-settings
    // and src/db/accountSettingsRepository.ts).
    for (const key of [
      'aiEnabled',
      'autoReplyEnabled',
      'deletedMessageArchiveEnabled',
      'viewOnceHandlingEnabled',
      'callHandlingEnabled',
      'moderationEnabled',
      'aiAutoReplyEnabled',
      'aiSemanticClassificationEnabled',
      'moderationDestructiveActionsEnabled',
      'dryRunEnabled',
      'vip',
      'neverAutoReply',
      'neverModerate',
      'quietHoursEnabled',
      'approvalRequired',
      'mediaArchiveEnabled',
    ] as const) {
      if (typeof body?.[key] === 'boolean') patch[key] = body[key];
    }
    if (typeof body?.customAiInstructions === 'string') {
      patch.customAiInstructions = body.customAiInstructions;
    }
    if (typeof body?.aiCooldownSeconds === 'number') {
      patch.aiCooldownSeconds = body.aiCooldownSeconds;
    }
    if (typeof body?.aiMaxResponsesPerHour === 'number' || body?.aiMaxResponsesPerHour === null) {
      patch.aiMaxResponsesPerHour = body.aiMaxResponsesPerHour ?? undefined;
    }
    if (
      typeof body?.deletedMessageRetentionDays === 'number' ||
      body?.deletedMessageRetentionDays === null
    ) {
      patch.deletedMessageRetentionDays = body.deletedMessageRetentionDays ?? undefined;
    }
    if (typeof body?.mediaMaxFileSizeBytes === 'number') {
      patch.mediaMaxFileSizeBytes = body.mediaMaxFileSizeBytes;
    }
    if (typeof body?.ownerNotes === 'string') patch.ownerNotes = body.ownerNotes;
    if (typeof body?.quietHoursTimezone === 'string' || body?.quietHoursTimezone === null) {
      patch.quietHoursTimezone = body.quietHoursTimezone ?? undefined;
    }
    if (Array.isArray(body?.quietHoursDays)) {
      patch.quietHoursDays = body.quietHoursDays.filter(
        (d: unknown): d is number => typeof d === 'number' && d >= 0 && d <= 6,
      );
    }
    if (typeof body?.quietHoursStartMinutes === 'number' || body?.quietHoursStartMinutes === null) {
      patch.quietHoursStartMinutes = body.quietHoursStartMinutes ?? undefined;
    }
    if (typeof body?.quietHoursEndMinutes === 'number' || body?.quietHoursEndMinutes === null) {
      patch.quietHoursEndMinutes = body.quietHoursEndMinutes ?? undefined;
    }
    if (
      typeof body?.deletedMessageAlertMode === 'string' &&
      DELETED_MESSAGE_ALERT_MODES.includes(body.deletedMessageAlertMode as never)
    ) {
      patch.deletedMessageAlertMode = body.deletedMessageAlertMode as DeletedMessageAlertMode;
    }

    const settings = await groupsRepository.updateSettings(id, patch);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: group.accountId,
      groupId: id,
      actor: 'owner',
      eventType: 'config.changed',
      detail: { patch },
    });

    res.status(200).json({ settings });
  });

  // Human Takeover — a friendly action endpoint over the same
  // humanTakeoverUntil field PATCH /settings accepts directly, so the
  // dashboard never has to compute an ISO timestamp from a duration itself.
  router.post('/:id/human-takeover', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);
    const group = await groupsRepository.getById(id);
    if (!group) {
      res.status(404).json({ error: 'group_not_found' });
      return;
    }

    const body = req.body as { durationMinutes?: unknown; resume?: unknown } | undefined;
    let humanTakeoverUntil: string | undefined;
    if (body?.resume === true) {
      humanTakeoverUntil = undefined;
    } else if (typeof body?.durationMinutes === 'number' && body.durationMinutes > 0) {
      humanTakeoverUntil = new Date(Date.now() + body.durationMinutes * 60_000).toISOString();
    } else {
      res.status(400).json({
        error: 'invalid_request',
        message: 'Provide a positive durationMinutes, or resume: true to end takeover early.',
      });
      return;
    }

    const settings = await groupsRepository.updateSettings(id, { humanTakeoverUntil });

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: group.accountId,
      groupId: id,
      actor: 'owner',
      eventType: 'human_takeover.changed',
      detail: { humanTakeoverUntil: humanTakeoverUntil ?? null },
    });

    res.status(200).json({ settings });
  });

  router.get('/:id/rules', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const rulesRepository = new RulesRepository(getSupabaseClient());
    const rules = await rulesRepository.listByGroup(id);
    res.status(200).json({ rules });
  });

  router.post('/:id/rules', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const group = await groupsRepository.getById(id);
    if (!group) {
      res.status(404).json({ error: 'group_not_found' });
      return;
    }

    const body = req.body as RuleFormInput | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'invalid_rule', message: 'A rule name is required.' });
      return;
    }
    const triggerType =
      typeof body?.triggerType === 'string' &&
      (TRIGGER_TYPES as readonly string[]).includes(body.triggerType)
        ? body.triggerType
        : 'response_threshold';

    try {
      const rule = await rulesRepository.create({
        groupId: id,
        name,
        triggerType,
        config: formToConfig(triggerType, body ?? {}),
      });

      const auditRepository = new AuditRepository(supabase);
      await auditRepository.recordEvent({
        accountId: group.accountId,
        groupId: id,
        actor: 'owner',
        eventType: 'rule.created',
        detail: { ruleId: rule.id, ruleName: rule.name },
      });

      res.status(201).json({ rule });
    } catch (err) {
      log.warn({ err, groupId: id }, 'Rejected invalid rule configuration');
      res.status(400).json({
        error: 'invalid_rule_config',
        message: err instanceof Error ? err.message : 'Invalid rule configuration.',
      });
    }
  });

  router.patch('/:id/rules/:ruleId', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const supabase = getSupabaseClient();
    const rulesRepository = new RulesRepository(supabase);

    const existing = await rulesRepository.getById(ruleId);
    if (!existing || existing.groupId !== id) {
      res.status(404).json({ error: 'rule_not_found' });
      return;
    }

    const body = req.body as (RuleFormInput & { enabled?: boolean }) | undefined;
    try {
      const patch: { name?: string; enabled?: boolean; config?: unknown } = {};
      if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      // A config-bearing field present means the whole form was
      // resubmitted — rebuild and validate the full config for this
      // rule's own trigger_type rather than trying to merge partial rule
      // internals (a rule's trigger_type never changes after creation).
      if (
        body?.phrases !== undefined ||
        body?.threshold !== undefined ||
        body?.bannedPhrases !== undefined ||
        body?.aiInstructions !== undefined
      ) {
        patch.config = formToConfig(existing.triggerType, {
          ...existing.config,
          ...body,
        } as RuleFormInput);
      }

      const rule = await rulesRepository.update(ruleId, patch);
      res.status(200).json({ rule });
    } catch (err) {
      log.warn({ err, ruleId }, 'Rejected invalid rule update');
      res.status(400).json({
        error: 'invalid_rule_config',
        message: err instanceof Error ? err.message : 'Invalid rule configuration.',
      });
    }
  });

  router.delete('/:id/rules/:ruleId', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const rulesRepository = new RulesRepository(getSupabaseClient());

    const existing = await rulesRepository.getById(ruleId);
    if (!existing || existing.groupId !== id) {
      res.status(404).json({ error: 'rule_not_found' });
      return;
    }

    await rulesRepository.remove(ruleId);
    res.status(200).json({ ok: true });
  });

  // Deleted-message archive (Phase 7 foundation) — safe metadata only,
  // never WhatsApp auth/session information.
  router.get('/:id/deleted-messages', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const messagesRepository = new MessagesRepository(getSupabaseClient());
    const messages = await messagesRepository.listDeletedByGroup(id);
    res.status(200).json({ messages });
  });

  // Archived media (Phase 8 foundation) — metadata only here; actual bytes
  // are fetched via a short-lived signed URL, never a public link.
  router.get('/:id/media-archive', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const mediaArchiveRepository = new MediaArchiveRepository(getSupabaseClient());
    const media = await mediaArchiveRepository.listByGroup(id);
    res.status(200).json({ media });
  });

  router.get('/:id/media-archive/:mediaId/url', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id, mediaId } = req.params as { id: string; mediaId: string };
    const supabase = getSupabaseClient();
    const mediaArchiveRepository = new MediaArchiveRepository(supabase);
    const items = await mediaArchiveRepository.listByGroup(id, 500);
    const item = items.find((m) => m.id === mediaId);
    if (!item) {
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    const { data, error } = await supabase.storage
      .from('whatsapp-media')
      .createSignedUrl(item.storagePath, 60); // 60s — just long enough for the dashboard to load it
    if (error || !data) {
      res.status(500).json({ error: 'signing_failed' });
      return;
    }
    res.status(200).json({ url: data.signedUrl });
  });

  return router;
}

export const RULE_TRIGGER_TYPES = TRIGGER_TYPES;
