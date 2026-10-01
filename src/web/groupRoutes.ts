import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import { GroupsRepository, type GroupSettingsPatch } from '../db/groupsRepository';
import { RulesRepository } from '../db/rulesRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { TRIGGER_TYPES } from '../rules/ruleConfig';
import { createChildLogger } from '../services/logger';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const log = createChildLogger('web:groups');

const MATCH_MODES = ['contains', 'exact', 'keyword_any'] as const;
const ACTION_TYPES = ['SEND_MESSAGE', 'NOTIFY_OWNER', 'LOG_ONLY'] as const;

/** Friendly shape the dashboard's rule builder form submits — no raw JSON required. */
interface RuleFormInput {
  name?: unknown;
  phrases?: unknown;
  matchMode?: unknown;
  threshold?: unknown;
  cooldownSeconds?: unknown;
  actionType?: unknown;
  message?: unknown;
  enabled?: unknown;
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
    // viewOnceHandlingEnabled / callHandlingEnabled / moderationEnabled /
    // customAiInstructions: configuration architecture only — not wired to
    // any behavior yet (Phase 6+). Accepting and persisting the toggle is
    // harmless and lets the dashboard show them as configured for when
    // those phases land, but intentionally does NOT turn on anything.
    for (const key of [
      'aiEnabled',
      'autoReplyEnabled',
      'deletedMessageArchiveEnabled',
      'viewOnceHandlingEnabled',
      'callHandlingEnabled',
      'moderationEnabled',
    ] as const) {
      if (typeof body?.[key] === 'boolean') patch[key] = body[key];
    }
    if (typeof body?.customAiInstructions === 'string') {
      patch.customAiInstructions = body.customAiInstructions;
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

    try {
      const rule = await rulesRepository.create({
        groupId: id,
        name,
        triggerType: 'response_threshold',
        config: ruleFormToConfig(body ?? {}),
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
      // A config-bearing field (phrases/threshold/etc.) present means the
      // whole form was resubmitted — rebuild and validate the full config
      // rather than trying to merge partial rule internals.
      if (body?.phrases !== undefined || body?.threshold !== undefined) {
        patch.config = ruleFormToConfig({ ...existing.config, ...body } as RuleFormInput);
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

  return router;
}

export const RULE_TRIGGER_TYPES = TRIGGER_TYPES;
