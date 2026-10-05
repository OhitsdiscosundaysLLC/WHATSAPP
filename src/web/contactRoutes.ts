import { Router, type Request, type Response } from 'express';
import { config } from '../config/config';
import { AuditRepository } from '../db/auditRepository';
import { ContactsRepository, type ContactSettingsPatch } from '../db/contactsRepository';
import { DELETED_MESSAGE_ALERT_MODES, type DeletedMessageAlertMode } from '../db/groupsRepository';
import { MediaArchiveRepository } from '../db/mediaArchiveRepository';
import { MessagesRepository } from '../db/messagesRepository';
import { RulesRepository } from '../db/rulesRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { simulateMessage } from '../rules/ruleSimulator';
import { createChildLogger } from '../services/logger';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const log = createChildLogger('web:contacts');

const MATCH_MODES = ['contains', 'exact', 'keyword_any'] as const;
const AUTO_REPLY_ACTION_TYPES = ['SEND_MESSAGE', 'AI_REPLY'] as const;

/** Friendly shape the dashboard's contact rule-builder form submits — same shape as the relevant group rule forms. */
interface ContactRuleFormInput {
  name?: unknown;
  triggerType?: unknown;
  phrases?: unknown;
  matchMode?: unknown;
  classifier?: unknown;
  aiInstructions?: unknown;
  cooldownSeconds?: unknown;
  actionType?: unknown;
  message?: unknown;
  // escalation
  category?: unknown;
  notifyOwner?: unknown;
  createInboxItem?: unknown;
  suppressAutoReply?: unknown;
}

const CONTACT_TRIGGER_TYPES = ['auto_reply', 'escalation'] as const;

function autoReplyFormToConfig(body: ContactRuleFormInput): unknown {
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

function escalationFormToConfig(body: ContactRuleFormInput): unknown {
  const phrases = Array.isArray(body.phrases)
    ? body.phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const matchMode = MATCH_MODES.includes(body.matchMode as (typeof MATCH_MODES)[number])
    ? body.matchMode
    : 'contains';

  return {
    qualify: { mode: matchMode, phrases },
    action: {
      category: typeof body.category === 'string' && body.category.trim() ? body.category : 'other',
      notifyOwner: body.notifyOwner === undefined ? true : Boolean(body.notifyOwner),
      createInboxItem: body.createInboxItem === undefined ? true : Boolean(body.createInboxItem),
      suppressAutoReply:
        body.suppressAutoReply === undefined ? true : Boolean(body.suppressAutoReply),
    },
    cooldownSeconds: Number(body.cooldownSeconds ?? 0),
  };
}

function contactFormToConfig(triggerType: string, body: ContactRuleFormInput): unknown {
  return triggerType === 'escalation' ? escalationFormToConfig(body) : autoReplyFormToConfig(body);
}

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message:
        'Private contacts require Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

export function createContactRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (_req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const accounts = new Map(accountManager.listAccounts().map((a) => [a.id, a.label]));
    const contacts = await contactsRepository.listAll();

    const payload = await Promise.all(
      contacts.map(async (contact) => {
        const [settings, rules] = await Promise.all([
          contactsRepository.ensureSettings(contact.id),
          rulesRepository.listByContact(contact.id),
        ]);
        return {
          id: contact.id,
          accountId: contact.accountId,
          accountLabel: accounts.get(contact.accountId) ?? 'Unknown account',
          whatsappJid: contact.whatsappJid,
          displayName: contact.displayName,
          blocked: contact.blocked,
          allowlisted: contact.allowlisted,
          discoveredAt: contact.discoveredAt,
          privateMonitoringEnabled: settings.privateMonitoringEnabled,
          privateAiEnabled: settings.privateAiEnabled,
          privateAutoReplyEnabled: settings.privateAutoReplyEnabled,
          ruleCount: rules.length,
        };
      }),
    );

    res.status(200).json({ contacts: payload });
  });

  router.get('/:id', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);

    const contact = await contactsRepository.getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const settings = await contactsRepository.ensureSettings(id);
    const accountLabel =
      accountManager.listAccounts().find((a) => a.id === contact.accountId)?.label ??
      'Unknown account';

    res.status(200).json({ contact: { ...contact, accountLabel }, settings });
  });

  /** Blocked / allowlisted / displayName — the contact row itself, not its automation settings. */
  router.patch('/:id', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);

    const contact = await contactsRepository.getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const body = req.body as { blocked?: unknown; allowlisted?: unknown; displayName?: unknown };
    const patch: { blocked?: boolean; allowlisted?: boolean; displayName?: string } = {};
    if (typeof body?.blocked === 'boolean') patch.blocked = body.blocked;
    if (typeof body?.allowlisted === 'boolean') patch.allowlisted = body.allowlisted;
    if (typeof body?.displayName === 'string') patch.displayName = body.displayName;

    const updated = await contactsRepository.updateContact(id, patch);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: contact.accountId,
      groupId: undefined,
      contactId: id,
      actor: 'owner',
      eventType: 'config.changed',
      detail: { patch, scope: 'private' },
    });

    res.status(200).json({ contact: updated });
  });

  router.patch('/:id/settings', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);

    const contact = await contactsRepository.getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const body = req.body as Partial<ContactSettingsPatch> | undefined;
    const patch: ContactSettingsPatch = {};
    for (const key of [
      'privateMonitoringEnabled',
      'privateAiEnabled',
      'privateAutoReplyEnabled',
      'privateAiAutoReplyEnabled',
      'privateAiSemanticClassificationEnabled',
      'privateDeletedMessageArchiveEnabled',
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
    if (typeof body?.customInstructions === 'string') {
      patch.customInstructions = body.customInstructions;
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

    const settings = await contactsRepository.updateSettings(id, patch);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: contact.accountId,
      groupId: undefined,
      contactId: id,
      actor: 'owner',
      eventType: 'config.changed',
      detail: { patch, scope: 'private' },
    });

    res.status(200).json({ settings });
  });

  // Human Takeover — see groupRoutes.ts's equivalent for why this is a
  // friendly action endpoint rather than making the dashboard compute an
  // ISO timestamp from a duration itself.
  router.post('/:id/human-takeover', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);
    const contact = await contactsRepository.getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
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

    const settings = await contactsRepository.updateSettings(id, { humanTakeoverUntil });

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: contact.accountId,
      groupId: undefined,
      contactId: id,
      actor: 'owner',
      eventType: 'human_takeover.changed',
      detail: { humanTakeoverUntil: humanTakeoverUntil ?? null },
    });

    res.status(200).json({ settings });
  });

  router.post('/:id/simulate', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contact = await new ContactsRepository(supabase).getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const body = req.body as
      | {
          senderJid?: unknown;
          text?: unknown;
          messageType?: unknown;
          quotedWhatsappMessageId?: unknown;
          quotedParticipant?: unknown;
          timestamp?: unknown;
        }
      | undefined;
    const senderJid = typeof body?.senderJid === 'string' ? body.senderJid.trim() : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!senderJid || !text) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'senderJid and text are required.',
      });
      return;
    }

    try {
      const outcome = await simulateMessage(
        supabase,
        config.authorization.ownerNumbers.map((n) => `${n}@s.whatsapp.net`),
        log,
        {
          contactId: id,
          senderJid,
          text,
          ...(typeof body?.messageType === 'string' ? { messageType: body.messageType } : {}),
          ...(typeof body?.quotedWhatsappMessageId === 'string' && body.quotedWhatsappMessageId
            ? { quotedWhatsappMessageId: body.quotedWhatsappMessageId }
            : {}),
          ...(typeof body?.quotedParticipant === 'string' && body.quotedParticipant
            ? { quotedParticipant: body.quotedParticipant }
            : {}),
          ...(typeof body?.timestamp === 'string' && body.timestamp
            ? { timestamp: body.timestamp }
            : {}),
        },
      );
      res.status(200).json(outcome);
    } catch (err) {
      log.warn({ err, contactId: id }, 'Rule simulation failed');
      res.status(400).json({
        error: 'simulation_failed',
        message: err instanceof Error ? err.message : 'Could not run the simulation.',
      });
    }
  });

  router.get('/:id/rules', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const rulesRepository = new RulesRepository(getSupabaseClient());
    const rules = await rulesRepository.listByContact(id);
    res.status(200).json({ rules });
  });

  router.post('/:id/rules', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const contactsRepository = new ContactsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const contact = await contactsRepository.getById(id);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const body = req.body as ContactRuleFormInput | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'invalid_rule', message: 'A rule name is required.' });
      return;
    }
    const triggerType = CONTACT_TRIGGER_TYPES.includes(
      body?.triggerType as (typeof CONTACT_TRIGGER_TYPES)[number],
    )
      ? (body?.triggerType as (typeof CONTACT_TRIGGER_TYPES)[number])
      : 'auto_reply';

    try {
      const rule = await rulesRepository.createForContact({
        contactId: id,
        name,
        triggerType,
        config: contactFormToConfig(triggerType, body ?? {}),
      });

      const auditRepository = new AuditRepository(supabase);
      await auditRepository.recordEvent({
        accountId: contact.accountId,
        groupId: undefined,
        contactId: id,
        actor: 'owner',
        eventType: 'rule.created',
        detail: { ruleId: rule.id, ruleName: rule.name, scope: 'private' },
      });

      res.status(201).json({ rule });
    } catch (err) {
      log.warn({ err, contactId: id }, 'Rejected invalid contact rule configuration');
      res.status(400).json({
        error: 'invalid_rule_config',
        message: err instanceof Error ? err.message : 'Invalid rule configuration.',
      });
    }
  });

  router.patch('/:id/rules/:ruleId', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const rulesRepository = new RulesRepository(getSupabaseClient());

    const existing = await rulesRepository.getById(ruleId);
    if (!existing || existing.contactId !== id) {
      res.status(404).json({ error: 'rule_not_found' });
      return;
    }

    const body = req.body as (ContactRuleFormInput & { enabled?: boolean }) | undefined;
    try {
      const patch: { name?: string; enabled?: boolean; config?: unknown } = {};
      if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (
        body?.phrases !== undefined ||
        body?.aiInstructions !== undefined ||
        body?.actionType !== undefined ||
        body?.category !== undefined ||
        body?.notifyOwner !== undefined ||
        body?.createInboxItem !== undefined ||
        body?.suppressAutoReply !== undefined
      ) {
        patch.config = contactFormToConfig(existing.triggerType, {
          ...(existing.config as ContactRuleFormInput),
          ...body,
        });
      }

      const rule = await rulesRepository.update(ruleId, patch);
      res.status(200).json({ rule });
    } catch (err) {
      log.warn({ err, ruleId }, 'Rejected invalid contact rule update');
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
    if (!existing || existing.contactId !== id) {
      res.status(404).json({ error: 'rule_not_found' });
      return;
    }

    await rulesRepository.remove(ruleId);
    res.status(200).json({ ok: true });
  });

  router.get('/:id/deleted-messages', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const messagesRepository = new MessagesRepository(getSupabaseClient());
    const messages = await messagesRepository.listDeletedByContact(id);
    res.status(200).json({ messages });
  });

  // Archived media (view-once + general) — metadata only here; actual bytes
  // are fetched via a short-lived signed URL, never a public link. DM-side
  // equivalent of groupRoutes.ts's media-archive routes.
  router.get('/:id/media-archive', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const mediaArchiveRepository = new MediaArchiveRepository(getSupabaseClient());
    const media = await mediaArchiveRepository.listByContact(id);
    res.status(200).json({ media });
  });

  router.get('/:id/media-archive/:mediaId/url', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id, mediaId } = req.params as { id: string; mediaId: string };
    const supabase = getSupabaseClient();
    const mediaArchiveRepository = new MediaArchiveRepository(supabase);
    const items = await mediaArchiveRepository.listByContact(id, 500);
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
