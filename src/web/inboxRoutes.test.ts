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

describe('inbox routes', () => {
  it('rejects unauthenticated access with 401', async () => {
    await request(app).get('/api/inbox').expect(401);
  });

  it('returns empty items when nothing has happened', async () => {
    const { cookie } = await login();
    const res = await request(app).get('/api/inbox').set('Cookie', cookie).expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('lists recorded inbox items', async () => {
    const { OwnerInboxRepository } = await import('../db/ownerInboxRepository');
    const inbox = new OwnerInboxRepository(fakeClient as never);
    await inbox.record({ accountId: 'acct-1', category: 'missed_call', title: 'Missed call' });
    await inbox.record({
      accountId: 'acct-1',
      category: 'deleted_message',
      title: 'A message was deleted',
    });

    const { cookie } = await login();
    const res = await request(app).get('/api/inbox').set('Cookie', cookie).expect(200);
    expect(res.body.items).toHaveLength(2);
    const titles = res.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain('Missed call');
    expect(titles).toContain('A message was deleted');
  });

  it('filters by unreadOnly', async () => {
    const { OwnerInboxRepository } = await import('../db/ownerInboxRepository');
    const inbox = new OwnerInboxRepository(fakeClient as never);
    await inbox.record({ accountId: 'acct-1', category: 'rule_fired', title: 'Rule fired' });
    const [item] = await inbox.list('acct-1', { includeDismissed: true, limit: 1 });
    await inbox.markRead(item!.id);

    const { cookie } = await login();
    const res = await request(app)
      .get('/api/inbox?unreadOnly=true')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.items.find((i: { id: string }) => i.id === item!.id)).toBeUndefined();
  });

  it('rejects POST /:id/read without a CSRF token', async () => {
    const { cookie } = await login();
    await request(app).post('/api/inbox/some-id/read').set('Cookie', cookie).expect(403);
  });

  it('marks an item read with a valid CSRF token', async () => {
    const { OwnerInboxRepository } = await import('../db/ownerInboxRepository');
    const inbox = new OwnerInboxRepository(fakeClient as never);
    await inbox.record({ accountId: 'acct-1', category: 'ai_failure', title: 'AI failed' });
    const [item] = await inbox.list('acct-1');

    const { cookie, csrfToken } = await login();
    await request(app)
      .post(`/api/inbox/${item!.id}/read`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const after = await inbox.list('acct-1', { includeDismissed: true });
    expect(after.find((i) => i.id === item!.id)).toMatchObject({ read: true });
  });

  it('dismisses an item, which then disappears from the default list', async () => {
    const { OwnerInboxRepository } = await import('../db/ownerInboxRepository');
    const inbox = new OwnerInboxRepository(fakeClient as never);
    await inbox.record({ accountId: 'acct-1', category: 'moderation', title: 'Moderated' });
    const [item] = await inbox.list('acct-1');

    const { cookie, csrfToken } = await login();
    await request(app)
      .post(`/api/inbox/${item!.id}/dismiss`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const after = await inbox.list('acct-1');
    expect(after.find((i) => i.id === item!.id)).toBeUndefined();
  });

  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app).get('/api/inbox').set('Cookie', cookie).expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});
