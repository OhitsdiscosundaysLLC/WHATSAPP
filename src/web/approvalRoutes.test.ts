import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FakeSupabaseClient } from '../db/fakeSupabaseClient';

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

let app: Express;
let fakeClient: FakeSupabaseClient;
let isSupabaseConfiguredMock: ReturnType<typeof vi.fn>;

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
  const cookie = loginRes.headers['set-cookie']![0]!;
  const pageRes = await request(app).get('/').set('Cookie', cookie).expect(200);
  const match = /csrf-token" content="([^"]+)"/.exec(pageRes.text);
  if (!match) throw new Error('csrf token not found');
  return { cookie, csrfToken: match[1]! };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.DASHBOARD_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.WHATSAPP_ENABLED = 'false';

  const { createServer } = await import('../server');
  const { accountManager } = await import('../whatsapp/accountManager');
  const supabaseClientModule = await import('../db/supabaseClient');
  const { checkDatabaseHealth, getSupabaseClient, isSupabaseConfigured } = supabaseClientModule;
  isSupabaseConfiguredMock = isSupabaseConfigured as unknown as ReturnType<typeof vi.fn>;
  fakeClient = getSupabaseClient() as unknown as FakeSupabaseClient;

  app = createServer({
    getWhatsAppStatus: () => accountManager.getAggregateStatus(),
    getDatabaseHealth: () => checkDatabaseHealth(),
    getAuthPersistence: () => accountManager.getStorageStatus(),
  });
  await accountManager.load();
});

describe('approval routes', () => {
  it('rejects unauthenticated access with 401', async () => {
    await request(app).get('/api/approvals').expect(401);
  });

  it('returns empty approvals when nothing is pending', async () => {
    const { cookie } = await login();
    const res = await request(app).get('/api/approvals').set('Cookie', cookie).expect(200);
    expect(res.body.approvals).toEqual([]);
  });

  it('lists pending approvals with an account label attached', async () => {
    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    await pendingApprovals.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'We are open 9-5.',
    });

    const { cookie } = await login();
    const res = await request(app).get('/api/approvals').set('Cookie', cookie).expect(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0]).toMatchObject({
      status: 'pending',
      proposedMessage: 'We are open 9-5.',
      accountLabel: 'Unknown account',
    });
  });

  it('filters by status', async () => {
    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    const approval = await pendingApprovals.create({
      accountId: 'acct-1',
      contactId: 'contact-1',
      targetChatJid: 'contact@s.whatsapp.net',
      proposedMessage: 'Hello there',
    });
    await pendingApprovals.reject(approval.id, 'owner');

    const { cookie } = await login();
    const res = await request(app)
      .get('/api/approvals?status=rejected')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0]).toMatchObject({ status: 'rejected' });
  });

  it('rejects POST /:id/approve without a CSRF token', async () => {
    const { cookie } = await login();
    await request(app).post('/api/approvals/some-id/approve').set('Cookie', cookie).expect(403);
  });

  it('approving dispatches the message and marks the approval sent', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    const sendSpy = vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValueOnce(undefined);

    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    const approval = await pendingApprovals.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ editedMessage: 'Edited reply' })
      .expect(200);

    expect(res.body.approval).toMatchObject({ status: 'sent', proposedMessage: 'Edited reply' });
    expect(sendSpy).toHaveBeenCalledWith('acct-1', 'group@g.us', 'Edited reply');
    expect(await pendingApprovals.getById(approval.id)).toMatchObject({ status: 'sent' });

    sendSpy.mockRestore();
  });

  it('a send failure after approval marks the row failed and never silently claims success', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    const sendSpy = vi
      .spyOn(accountManager, 'sendTextMessage')
      .mockRejectedValueOnce(new Error('not connected'));

    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const { OwnerInboxRepository } = await import('../db/ownerInboxRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    const ownerInbox = new OwnerInboxRepository(fakeClient as never);
    const approval = await pendingApprovals.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const { cookie, csrfToken } = await login();
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(502);

    expect(await pendingApprovals.getById(approval.id)).toMatchObject({ status: 'failed' });
    const inboxItems = await ownerInbox.list('acct-1');
    expect(inboxItems.find((i) => i.category === 'automation_failure')).toBeTruthy();

    sendSpy.mockRestore();
  });

  it('a second approve on an already-decided item returns 409, never double-sends', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    const sendSpy = vi.spyOn(accountManager, 'sendTextMessage').mockResolvedValue(undefined);

    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    const approval = await pendingApprovals.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const { cookie, csrfToken } = await login();
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(200);

    const res = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(409);

    expect(res.body.error).toBe('already_decided');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    sendSpy.mockRestore();
  });

  it('rejecting discards the item without ever sending', async () => {
    const { accountManager } = await import('../whatsapp/accountManager');
    const sendSpy = vi.spyOn(accountManager, 'sendTextMessage');

    const { PendingApprovalsRepository } = await import('../db/pendingApprovalsRepository');
    const pendingApprovals = new PendingApprovalsRepository(fakeClient as never);
    const approval = await pendingApprovals.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .post(`/api/approvals/${approval.id}/reject`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    expect(res.body.approval).toMatchObject({ status: 'rejected' });
    expect(sendSpy).not.toHaveBeenCalled();

    await request(app)
      .post(`/api/approvals/${approval.id}/reject`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(409);

    sendSpy.mockRestore();
  });

  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app).get('/api/approvals').set('Cookie', cookie).expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});
