import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AuditRepository } from '../db/auditRepository';
import { ContactsRepository } from '../db/contactsRepository';
import { GroupsRepository } from '../db/groupsRepository';
import { MediaArchiveRepository } from '../db/mediaArchiveRepository';
import { OutboundSendsRepository, type OutboundMessageType } from '../db/outboundSendsRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { createChildLogger } from '../services/logger';
import { accountManager } from '../whatsapp/accountManager';
import type { OutboundMediaContent } from '../whatsapp/connectionManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const log = createChildLogger('web:media-console');
const MAX_LIMIT = 200;

/**
 * Generous enough for a voice note, a photo, or a short video while
 * keeping the JSON request body (base64 adds ~33% overhead — see
 * server.ts's raised `express.json()` limit) bounded. Enforced on the
 * DECODED buffer, independent of whatever the client claims.
 */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const MIME_PREFIX: Record<'image' | 'video' | 'audio', string> = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
};

/** Only the types WhatsApp's own clients support `viewOnce` for — never document. */
const VIEW_ONCE_ELIGIBLE = new Set(['image', 'video', 'audio', 'voice_note']);
/** Only the types WhatsApp's own clients show a caption field for — never audio/voice note. */
const CAPTION_ELIGIBLE = new Set(['image', 'video', 'document']);

const sendSchema = z.object({
  requestId: z.string().min(1).max(200),
  accountId: z.string().min(1),
  destinationType: z.enum(['contact', 'group', 'self']),
  destinationId: z.string().min(1).optional(),
  messageType: z.enum(['text', 'image', 'video', 'audio', 'voice_note', 'document']),
  text: z.string().min(1).max(4096).optional(),
  caption: z.string().max(1024).optional(),
  viewOnce: z.boolean().optional(),
  fileBase64: z.string().min(1).optional(),
  fileName: z.string().min(1).max(255).optional(),
  mimeType: z.string().min(1).max(255).optional(),
});

interface ResolvedDestination {
  jid: string;
  groupId: string | undefined;
  contactId: string | undefined;
}

async function resolveDestination(
  accountId: string,
  destinationType: 'contact' | 'group' | 'self',
  destinationId: string | undefined,
  groupsRepository: GroupsRepository,
  contactsRepository: ContactsRepository,
): Promise<ResolvedDestination | { error: string }> {
  if (destinationType === 'group') {
    if (!destinationId) return { error: 'destinationId is required for a group' };
    const group = await groupsRepository.getById(destinationId);
    if (!group || group.accountId !== accountId) return { error: 'group_not_found' };
    return { jid: group.whatsappGroupJid, groupId: group.id, contactId: undefined };
  }
  if (destinationType === 'contact') {
    if (!destinationId) return { error: 'destinationId is required for a contact' };
    const contact = await contactsRepository.getById(destinationId);
    if (!contact || contact.accountId !== accountId) return { error: 'contact_not_found' };
    return { jid: contact.whatsappJid, groupId: undefined, contactId: contact.id };
  }
  // 'self' — "Message Yourself" is an ordinary WhatsApp private chat whose
  // JID is the connected account's own number. Upserted as a regular
  // contact so storage/archival scoping (exactly one of groupId/contactId)
  // needs no special case anywhere else in the codebase.
  const ownJid = accountManager.getOwnJid(accountId);
  if (!ownJid) return { error: 'account_not_connected' };
  const contact = await contactsRepository.upsertDiscoveredContact(accountId, ownJid, 'Myself');
  return { jid: ownJid, groupId: undefined, contactId: contact.id };
}

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message:
        'The Owner Media Console requires Supabase to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

/**
 * Owner Media Console: lets the authenticated dashboard owner manually
 * compose and send a WhatsApp message to a known contact, a known group,
 * or themselves. The ONLY place `WhatsAppConnectionManager.sendMediaMessage`
 * is called from an HTTP path — every automated send (rule engine,
 * moderation, commands, daily summary, approvals) uses `sendTextMessage`
 * directly and has no reference to this router or to
 * `OutboundSendsRepository`, which is what keeps a manual send
 * structurally distinguishable from automation (never bypassable by
 * automation "pretending" to be manual — see docs/SECURITY.md). Emergency
 * Pause (`automation_paused`) has no bearing here: it only stops
 * autonomous actions, never an explicit owner action.
 */
export function createMediaConsoleRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/destinations', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);
    const contactsRepository = new ContactsRepository(supabase);
    const [groups, contacts] = await Promise.all([
      groupsRepository.listAll(),
      contactsRepository.listAll(),
    ]);
    const accounts = accountManager.listAccounts().map((a) => ({
      id: a.id,
      label: a.label,
      connected: a.status.state === 'connected',
    }));
    res.status(200).json({
      accounts,
      groups: groups.map((g) => ({
        id: g.id,
        accountId: g.accountId,
        label: g.subject,
        jid: g.whatsappGroupJid,
      })),
      contacts: contacts
        .filter((c) => !c.blocked)
        .map((c) => ({
          id: c.id,
          accountId: c.accountId,
          label: c.displayName || c.whatsappJid,
          jid: c.whatsappJid,
        })),
    });
  });

  router.get('/sent', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const query = req.query as { accountId?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 50, MAX_LIMIT);
    const outboundSends = new OutboundSendsRepository(getSupabaseClient());
    const sends = await outboundSends.list(query.accountId, limit);
    const accounts = new Map(accountManager.listAccounts().map((a) => [a.id, a.label]));
    res.status(200).json({
      sends: sends.map((s) => ({
        ...s,
        accountLabel: accounts.get(s.accountId) ?? 'Unknown account',
      })),
    });
  });

  /** Signed URL (60s) for a sent item's archived media — reuses the exact lookup/signing pattern groupRoutes.ts/contactRoutes.ts use for incoming media. Never a permanent/public URL. */
  router.get('/sent/:id/media-url', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const outboundSends = new OutboundSendsRepository(getSupabaseClient());
    const sends = await outboundSends.list(undefined, MAX_LIMIT);
    const sent = sends.find((s) => s.id === id);
    if (!sent || !sent.whatsappMessageId) {
      res.status(404).json({ error: 'send_not_found' });
      return;
    }
    const mediaArchiveRepository = new MediaArchiveRepository(supabase);
    const archived = await mediaArchiveRepository.findByMessageId(
      sent.accountId,
      sent.whatsappMessageId,
    );
    if (!archived) {
      res.status(404).json({
        error: 'media_not_yet_archived',
        message: 'WhatsApp has not echoed this sent message back yet — try again shortly.',
      });
      return;
    }
    const { data, error } = await supabase.storage
      .from('whatsapp-media')
      .createSignedUrl(archived.storagePath, 60);
    if (error || !data) {
      res.status(500).json({ error: 'signing_failed' });
      return;
    }
    res.status(200).json({ url: data.signedUrl });
  });

  router.post('/send', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;

    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    if (body.messageType === 'text') {
      if (!body.text) {
        res.status(400).json({ error: 'text_required' });
        return;
      }
    } else {
      if (!body.fileBase64 || !body.mimeType) {
        res.status(400).json({ error: 'file_required' });
        return;
      }
      if (body.messageType === 'document' && !body.fileName) {
        res.status(400).json({ error: 'file_name_required_for_document' });
        return;
      }
      if (
        body.messageType in MIME_PREFIX &&
        !body.mimeType.startsWith(MIME_PREFIX[body.messageType as keyof typeof MIME_PREFIX])
      ) {
        res.status(400).json({ error: 'mime_type_mismatch' });
        return;
      }
      if (body.messageType === 'voice_note' && !body.mimeType.startsWith('audio/')) {
        res.status(400).json({ error: 'mime_type_mismatch' });
        return;
      }
      if (body.caption !== undefined && !CAPTION_ELIGIBLE.has(body.messageType)) {
        res.status(400).json({ error: 'caption_not_supported_for_this_type' });
        return;
      }
      if (body.viewOnce && !VIEW_ONCE_ELIGIBLE.has(body.messageType)) {
        res.status(400).json({ error: 'view_once_not_supported_for_this_type' });
        return;
      }
    }

    let buffer: Buffer | undefined;
    if (body.fileBase64) {
      try {
        buffer = Buffer.from(body.fileBase64, 'base64');
      } catch {
        res.status(400).json({ error: 'invalid_file_encoding' });
        return;
      }
      if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE_BYTES) {
        res.status(400).json({ error: 'file_too_large_or_empty', maxBytes: MAX_FILE_SIZE_BYTES });
        return;
      }
    }

    const supabase = getSupabaseClient();
    const groupsRepository = new GroupsRepository(supabase);
    const contactsRepository = new ContactsRepository(supabase);
    const outboundSends = new OutboundSendsRepository(supabase);
    const auditRepository = new AuditRepository(supabase);

    if (!accountManager.hasAccount(body.accountId)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    // Idempotency, part 1: a resubmission of a request this account has
    // already fully handled returns that original result rather than
    // sending again.
    const existing = await outboundSends.findByRequestId(body.accountId, body.requestId);
    if (existing && existing.status !== 'pending') {
      res.status(200).json({ send: existing, idempotentReplay: true });
      return;
    }

    const destination = await resolveDestination(
      body.accountId,
      body.destinationType,
      body.destinationId,
      groupsRepository,
      contactsRepository,
    );
    if ('error' in destination) {
      res.status(400).json({ error: destination.error });
      return;
    }

    // Idempotency, part 2: atomically reserve (account_id, request_id)
    // BEFORE attempting the actual WhatsApp send — see
    // OutboundSendsRepository.reserve()'s doc comment. A lost race here
    // means another concurrent request with this exact requestId is
    // already handling the send.
    const reserved = await outboundSends.reserve({
      accountId: body.accountId,
      requestId: body.requestId,
      groupId: destination.groupId,
      contactId: destination.contactId,
      destinationJid: destination.jid,
      messageType: body.messageType as OutboundMessageType,
      textBody: body.messageType === 'text' ? body.text : undefined,
      caption: body.caption,
      viewOnce: body.viewOnce === true,
      fileName: body.fileName,
      mimeType: body.mimeType,
      fileSizeBytes: buffer?.length,
    });
    if (!reserved) {
      res.status(409).json({
        error: 'duplicate_in_flight',
        message: 'This exact send is already being processed.',
      });
      return;
    }

    try {
      let whatsappMessageId: string | undefined;
      if (body.messageType === 'text') {
        await accountManager.sendTextMessage(body.accountId, destination.jid, body.text!);
        // sendTextMessage doesn't return Baileys' message id today — the
        // Message Vault still shows this send (text body + status), just
        // without a deep link to an echoed/archived copy (text has
        // nothing to archive as media anyway; the body IS the record).
        whatsappMessageId = undefined;
      } else {
        const content = buildOutboundMediaContent(body, buffer!);
        const result = await accountManager.sendMediaMessage(
          body.accountId,
          destination.jid,
          content,
        );
        whatsappMessageId = result.id;
      }

      await outboundSends.finalize(reserved.id, { status: 'sent', whatsappMessageId });
      await auditRepository.recordEvent({
        accountId: body.accountId,
        groupId: destination.groupId,
        contactId: destination.contactId,
        actor: 'owner',
        eventType: 'media_console.sent',
        detail: { messageType: body.messageType, destinationType: body.destinationType },
      });
      const finalRecord = await outboundSends.findByRequestId(body.accountId, body.requestId);
      res.status(200).json({ send: finalRecord });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ err, accountId: body.accountId }, 'Owner Media Console send failed');
      await outboundSends.finalize(reserved.id, { status: 'failed', errorMessage });
      await auditRepository.recordEvent({
        accountId: body.accountId,
        groupId: destination.groupId,
        contactId: destination.contactId,
        actor: 'owner',
        eventType: 'media_console.failed',
        detail: { messageType: body.messageType, error: errorMessage },
      });
      res.status(502).json({ error: 'send_failed', message: errorMessage });
    }
  });

  return router;
}

function buildOutboundMediaContent(
  body: z.infer<typeof sendSchema>,
  buffer: Buffer,
): OutboundMediaContent {
  const caption = body.caption !== undefined ? { caption: body.caption } : {};
  const viewOnce = { viewOnce: body.viewOnce === true };
  switch (body.messageType) {
    case 'image':
      return { type: 'image', buffer, mimetype: body.mimeType!, ...caption, ...viewOnce };
    case 'video':
      return { type: 'video', buffer, mimetype: body.mimeType!, ...caption, ...viewOnce };
    case 'audio':
    case 'voice_note':
      return {
        type: 'audio',
        buffer,
        mimetype: body.mimeType!,
        ptt: body.messageType === 'voice_note',
        ...viewOnce,
      };
    case 'document':
      return {
        type: 'document',
        buffer,
        mimetype: body.mimeType!,
        fileName: body.fileName!,
        ...caption,
      };
    case 'text':
      throw new Error('buildOutboundMediaContent must never be called for messageType "text"');
  }
}
