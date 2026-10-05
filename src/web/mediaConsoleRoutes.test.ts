import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactsRepository } from '../db/contactsRepository';
import type { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import type { GroupsRepository } from '../db/groupsRepository';
import type { MediaArchiveRepository } from '../db/mediaArchiveRepository';

vi.mock('../db/supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/supabaseClient')>();
  const { FakeSupabaseClient: Fake } = await import('../db/fakeSupabaseClient');
  const client = new Fake();
  return {
    ...actual,
    isSupabaseConfigured: vi.fn(() => true),
    getSupabaseClient: vi.fn(() => client),
  };
});

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const ACCOUNT_ID = 'acct-1';

let app: Express;
let fakeClient: FakeSupabaseClient;
let groupsRepository: GroupsRepository;
let contactsRepository: ContactsRepository;
let mediaArchiveRepository: MediaArchiveRepository;

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
  const cookie = loginRes.headers['set-cookie']![0]!;
  const pageRes = await request(app).get('/').set('Cookie', cookie).expect(200);
  const match = /csrf-token" content="([^"]+)"/.exec(pageRes.text);
  if (!match) throw new Error('csrf token not found');
  return { cookie, csrfToken: match[1]! };
}

function requestId(): string {
  return `req-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.DASHBOARD_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.WHATSAPP_ENABLED = 'false';

  const { createServer } = await import('../server');
  const { accountManager } = await import('../whatsapp/accountManager');
  const supabaseClientModule = await import('../db/supabaseClient');
  const { checkDatabaseHealth, getSupabaseClient } = supabaseClientModule;
  fakeClient = getSupabaseClient() as unknown as FakeSupabaseClient;

  const { GroupsRepository } = await import('../db/groupsRepository');
  const { ContactsRepository } = await import('../db/contactsRepository');
  const { MediaArchiveRepository } = await import('../db/mediaArchiveRepository');
  groupsRepository = new GroupsRepository(fakeClient as never);
  contactsRepository = new ContactsRepository(fakeClient as never);
  mediaArchiveRepository = new MediaArchiveRepository(fakeClient as never);

  // FakeSupabaseClient only simulates `.from(table)` (Postgres), never
  // Supabase Storage — attach a minimal working `.storage` so
  // GET /sent/:id/media-url's `createSignedUrl` call succeeds.
  (fakeClient as unknown as { storage: unknown }).storage = {
    from: () => ({
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://example.invalid/signed/${path}` },
        error: null,
      }),
    }),
  };

  app = createServer({
    getWhatsAppStatus: () => accountManager.getAggregateStatus(),
    getDatabaseHealth: () => checkDatabaseHealth(),
    getAuthPersistence: () => accountManager.getStorageStatus(),
  });
  await accountManager.load();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('media console routes', () => {
  it('rejects unauthenticated access to every route', async () => {
    await request(app).get('/api/media-console/destinations').expect(401);
    await request(app).get('/api/media-console/sent').expect(401);
    await request(app).post('/api/media-console/send').send({}).expect(401);
  });

  it('rejects a send with no CSRF token', async () => {
    const { cookie } = await login();
    await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'self',
        messageType: 'text',
        text: 'hi',
      })
      .expect(403);
  });

  it('lists groups and contacts as destinations', async () => {
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'dest-group@g.us', 'Dest Group');
    await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'dest-contact@s.whatsapp.net',
      'Dest Contact',
    );

    const { cookie } = await login();
    const res = await request(app)
      .get('/api/media-console/destinations')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.groups.some((g: { jid: string }) => g.jid === 'dest-group@g.us')).toBe(true);
    expect(
      res.body.contacts.some((c: { jid: string }) => c.jid === 'dest-contact@s.whatsapp.net'),
    ).toBe(true);
  });

  it('400s for an unknown account', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: 'not-a-real-account',
        destinationType: 'self',
        messageType: 'text',
        text: 'hi',
      })
      .expect(404);
    expect(res.body.error).toBe('account_not_found');
  });

  it('400s for a group destination that does not exist', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'group',
        destinationId: 'nonexistent-group-id',
        messageType: 'text',
        text: 'hi',
      })
      .expect(400);
    expect(res.body.error).toBe('group_not_found');
  });

  it('sends a text message to a known contact and records it as sent', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-text@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const sendSpy = vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValue(undefined);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'text',
        text: 'Hello from the console',
      })
      .expect(200);

    expect(sendSpy).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'send-text@s.whatsapp.net',
      'Hello from the console',
    );
    expect(res.body.send).toMatchObject({
      status: 'sent',
      messageType: 'text',
      textBody: 'Hello from the console',
    });
  });

  it('resolves "self" to the account\'s own JID, upserting it as a contact', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'getOwnJid').mockReturnValue('15559990000@s.whatsapp.net');
    vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValue(undefined);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'self',
        messageType: 'text',
        text: 'Note to self',
      })
      .expect(200);

    expect(res.body.send.destinationJid).toBe('15559990000@s.whatsapp.net');
    const contact = await contactsRepository.getByJid(ACCOUNT_ID, '15559990000@s.whatsapp.net');
    expect(contact).toBeDefined();
  });

  it('400s "self" when the account is not currently connected (getOwnJid returns undefined)', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'getOwnJid').mockReturnValue(undefined);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'self',
        messageType: 'text',
        text: 'hi',
      })
      .expect(400);
    expect(res.body.error).toBe('account_not_connected');
  });

  it('sends an image with a caption and viewOnce, recording the id Baileys returned', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-image@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const mediaSpy = vi
      .spyOn(accountManager, 'sendMediaMessage')
      .mockResolvedValue({ id: 'WAMID-IMG-1' });
    const { cookie, csrfToken } = await login();

    const fileBase64 = Buffer.from('fake-image-bytes').toString('base64');
    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'image',
        caption: 'Check this out',
        viewOnce: true,
        fileBase64,
        mimeType: 'image/png',
        fileName: 'photo.png',
      })
      .expect(200);

    expect(mediaSpy).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'send-image@s.whatsapp.net',
      expect.objectContaining({ type: 'image', caption: 'Check this out', viewOnce: true }),
    );
    expect(res.body.send).toMatchObject({
      status: 'sent',
      whatsappMessageId: 'WAMID-IMG-1',
      viewOnce: true,
      caption: 'Check this out',
    });
  });

  it('rejects a caption on a voice note — WhatsApp audio has no caption field', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-voice@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'voice_note',
        caption: 'should not be allowed',
        fileBase64: Buffer.from('audio').toString('base64'),
        mimeType: 'audio/ogg',
      })
      .expect(400);
    expect(res.body.error).toBe('caption_not_supported_for_this_type');
  });

  it('rejects viewOnce on a document — WhatsApp never offers View Once for documents', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-doc@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'document',
        viewOnce: true,
        fileBase64: Buffer.from('doc').toString('base64'),
        mimeType: 'application/pdf',
        fileName: 'file.pdf',
      })
      .expect(400);
    expect(res.body.error).toBe('view_once_not_supported_for_this_type');
  });

  it('rejects a mime type that does not match the declared message type', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-mismatch@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'image',
        fileBase64: Buffer.from('not-an-image').toString('base64'),
        mimeType: 'video/mp4',
      })
      .expect(400);
    expect(res.body.error).toBe('mime_type_mismatch');
  });

  it('requires a fileName for a document', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-nofname@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'document',
        fileBase64: Buffer.from('doc').toString('base64'),
        mimeType: 'application/pdf',
      })
      .expect(400);
    expect(res.body.error).toBe('file_name_required_for_document');
  });

  it('a resubmission of the exact same requestId returns the original result and never sends twice', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-idempotent@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    const sendSpy = vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValue(undefined);
    const { cookie, csrfToken } = await login();
    const id = requestId();
    const body = {
      requestId: id,
      accountId: ACCOUNT_ID,
      destinationType: 'contact',
      destinationId: contact.id,
      messageType: 'text',
      text: 'once only',
    };

    const first = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(body)
      .expect(200);
    const second = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(body)
      .expect(200);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.send.id).toBe(first.body.send.id);
  });

  it('a send that fails is recorded as failed with the error, and returns 502', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-fails@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'sendTextMessage').mockRejectedValue(new Error('not connected'));
    const { cookie, csrfToken } = await login();

    const res = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'text',
        text: 'will fail',
      })
      .expect(502);

    expect(res.body.error).toBe('send_failed');

    const vaultRes = await request(app)
      .get('/api/media-console/sent')
      .set('Cookie', cookie)
      .expect(200);
    const failed = vaultRes.body.sends.find((s: { status: string }) => s.status === 'failed');
    expect(failed).toMatchObject({ status: 'failed', errorMessage: 'not connected' });
  });

  it('lists sent items with an account label attached', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-listed@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValue(undefined);
    const { cookie, csrfToken } = await login();

    await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'text',
        text: 'listed',
      })
      .expect(200);

    const res = await request(app).get('/api/media-console/sent').set('Cookie', cookie).expect(200);
    expect(res.body.sends.some((s: { textBody: string }) => s.textBody === 'listed')).toBe(true);
  });

  it('GET /sent/:id/media-url 404s when the sent media has not been archived yet', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-media-pending@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'sendMediaMessage').mockResolvedValue({ id: 'WAMID-PENDING' });
    const { cookie, csrfToken } = await login();

    const sendRes = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'image',
        fileBase64: Buffer.from('img').toString('base64'),
        mimeType: 'image/png',
      })
      .expect(200);

    const res = await request(app)
      .get(`/api/media-console/sent/${sendRes.body.send.id}/media-url`)
      .set('Cookie', cookie)
      .expect(404);
    expect(res.body.error).toBe('media_not_yet_archived');
  });

  it('GET /sent/:id/media-url returns a signed URL once the echoed message has been archived', async () => {
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'send-media-archived@s.whatsapp.net',
      undefined,
    );
    const { accountManager } = await import('../whatsapp/accountManager');
    vi.spyOn(accountManager, 'hasAccount').mockReturnValue(true);
    vi.spyOn(accountManager, 'sendMediaMessage').mockResolvedValue({ id: 'WAMID-ARCHIVED-1' });
    const { cookie, csrfToken } = await login();

    const sendRes = await request(app)
      .post('/api/media-console/send')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        requestId: requestId(),
        accountId: ACCOUNT_ID,
        destinationType: 'contact',
        destinationId: contact.id,
        messageType: 'image',
        fileBase64: Buffer.from('img').toString('base64'),
        mimeType: 'image/png',
      })
      .expect(200);

    // Simulate the event pipeline's fromMe echo having archived it.
    await mediaArchiveRepository.record({
      accountId: ACCOUNT_ID,
      groupId: undefined,
      contactId: contact.id,
      whatsappMessageId: 'WAMID-ARCHIVED-1',
      senderJid: 'me',
      isViewOnce: false,
      storagePath: `${ACCOUNT_ID}/contact-${contact.id}/WAMID-ARCHIVED-1`,
      mimeType: 'image/png',
      fileSizeBytes: 3,
      sha256: undefined,
    });

    const res = await request(app)
      .get(`/api/media-console/sent/${sendRes.body.send.id}/media-url`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.url).toBeDefined();
  });
});
