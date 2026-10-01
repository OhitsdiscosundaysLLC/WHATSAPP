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

async function login(): Promise<string> {
  const loginRes = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
  return loginRes.headers['set-cookie']![0]!;
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

describe('activity route', () => {
  it('rejects unauthenticated access with 401', async () => {
    await request(app).get('/api/activity').expect(401);
  });

  it('returns empty events/actions when nothing has happened', async () => {
    const cookie = await login();
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.actions).toEqual([]);
  });

  it('lists recorded events and actions', async () => {
    const { AuditRepository } = await import('../db/auditRepository');
    const audit = new AuditRepository(fakeClient as never);
    await audit.recordEvent({ accountId: 'acct-1', groupId: 'group-1', eventType: 'rule.fired' });
    await audit.recordAction({
      accountId: 'acct-1',
      groupId: 'group-1',
      ruleId: 'rule-1',
      triggerWhatsappMessageId: 'MSG1',
      actionType: 'SEND_MESSAGE',
      status: 'success',
    });

    const cookie = await login();
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(res.body.events.some((e: { eventType: string }) => e.eventType === 'rule.fired')).toBe(
      true,
    );
    expect(
      res.body.actions.some((a: { actionType: string }) => a.actionType === 'SEND_MESSAGE'),
    ).toBe(true);
  });

  it('filters by groupId when provided', async () => {
    const { AuditRepository } = await import('../db/auditRepository');
    const audit = new AuditRepository(fakeClient as never);
    await audit.recordEvent({
      accountId: 'acct-1',
      groupId: 'group-only-a',
      eventType: 'message.received',
    });
    await audit.recordEvent({
      accountId: 'acct-1',
      groupId: 'group-only-b',
      eventType: 'message.received',
    });

    const cookie = await login();
    const res = await request(app)
      .get('/api/activity?groupId=group-only-a')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.events.every((e: { groupId: string }) => e.groupId === 'group-only-a')).toBe(
      true,
    );
  });

  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const cookie = await login();
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });

  it('never includes credential/key material in the response', async () => {
    const cookie = await login();
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/ciphertext|encryptionKey|auth_tag|service_role/i);
  });
});
