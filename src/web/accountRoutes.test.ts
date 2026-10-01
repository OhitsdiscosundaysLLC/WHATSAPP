import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
let isSupabaseConfiguredMock: ReturnType<typeof vi.fn>;
let accountId: string;

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
  const cookie = loginRes.headers['set-cookie']![0]!;
  const pageRes = await request(app).get('/').set('Cookie', cookie).expect(200);
  const match = /csrf-token" content="([^"]+)"/.exec(pageRes.text);
  if (!match) throw new Error('csrf token not found');
  return { cookie, csrfToken: match[1]! };
}

let tmpAuthDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.DASHBOARD_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.WHATSAPP_ENABLED = 'false';
  // accountManager.createAccount() below writes through file-based storage
  // (SUPABASE_URL isn't set in this test process) — point it at a tmp dir
  // so these tests never touch the real repo's ./auth directory.
  tmpAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-account-routes-test-'));
  process.env.WHATSAPP_AUTH_DIR = tmpAuthDir;

  const { createServer } = await import('../server');
  const { accountManager } = await import('../whatsapp/accountManager');
  const supabaseClientModule = await import('../db/supabaseClient');
  const { checkDatabaseHealth, isSupabaseConfigured } = supabaseClientModule;
  isSupabaseConfiguredMock = isSupabaseConfigured as unknown as ReturnType<typeof vi.fn>;

  app = createServer({
    getWhatsAppStatus: () => accountManager.getAggregateStatus(),
    getDatabaseHealth: () => checkDatabaseHealth(),
    getAuthPersistence: () => accountManager.getStorageStatus(),
  });
  await accountManager.load();
  const account = await accountManager.createAccount('Test Account');
  accountId = account.id;
});

afterAll(async () => {
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHATSAPP_AUTH_DIR;
  await fs.rm(tmpAuthDir, { recursive: true, force: true });
});

describe('account routes — call settings', () => {
  it('rejects unauthenticated access', async () => {
    await request(app).get(`/api/accounts/${accountId}/call-settings`).expect(401);
  });

  it('returns safe defaults for a new account (call handling off, LOG_ONLY)', async () => {
    const { cookie } = await login();
    const res = await request(app)
      .get(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.settings).toMatchObject({
      callHandlingEnabled: false,
      callResponseAction: 'LOG_ONLY',
    });
  });

  it('404s for an unknown account id', async () => {
    const { cookie } = await login();
    await request(app)
      .get('/api/accounts/does-not-exist/call-settings')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('rejects PATCH without a CSRF token', async () => {
    const { cookie } = await login();
    await request(app)
      .patch(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .send({ callHandlingEnabled: true })
      .expect(403);
  });

  it('updates call settings with a valid CSRF token', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .patch(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ callHandlingEnabled: true, callResponseAction: 'AUTO_REJECT' })
      .expect(200);
    expect(res.body.settings).toMatchObject({
      callHandlingEnabled: true,
      callResponseAction: 'AUTO_REJECT',
    });
  });

  it('rejects an invalid callResponseAction value (ignored, not applied)', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .patch(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ callResponseAction: 'DO_SOMETHING_DANGEROUS' })
      .expect(200);
    expect(res.body.settings.callResponseAction).not.toBe('DO_SOMETHING_DANGEROUS');
  });

  it('Emergency Pause: defaults to false, and can be toggled via the same settings endpoint', async () => {
    const { cookie, csrfToken } = await login();
    const getRes = await request(app)
      .get(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .expect(200);
    expect(getRes.body.settings.automationPaused).toBe(false);

    const patchRes = await request(app)
      .patch(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ automationPaused: true })
      .expect(200);
    expect(patchRes.body.settings.automationPaused).toBe(true);

    const confirmRes = await request(app)
      .get(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .expect(200);
    expect(confirmRes.body.settings.automationPaused).toBe(true);
  });

  it('returns 503 when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app)
      .get(`/api/accounts/${accountId}/call-settings`)
      .set('Cookie', cookie)
      .expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});
