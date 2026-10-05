import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
let sourceAccountId: string;
let targetAccountId: string;
let tmpAuthDir: string;

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
  tmpAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-backup-routes-test-'));
  process.env.WHATSAPP_AUTH_DIR = tmpAuthDir;

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
  sourceAccountId = (await accountManager.createAccount('Source Account')).id;
  targetAccountId = (await accountManager.createAccount('Target Account')).id;
});

afterAll(async () => {
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHATSAPP_AUTH_DIR;
  await fs.rm(tmpAuthDir, { recursive: true, force: true });
});

const AUTO_REPLY_CONFIG = {
  qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
  action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
  cooldownSeconds: 0,
};

describe('backup routes — export', () => {
  it('rejects unauthenticated access with 401', async () => {
    await request(app).get(`/api/backup/export?accountId=${sourceAccountId}`).expect(401);
  });

  it('404s an unknown account', async () => {
    const { cookie } = await login();
    await request(app)
      .get('/api/backup/export?accountId=does-not-exist')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('exports a safe document with no credential fields anywhere', async () => {
    const { cookie } = await login();

    const { GroupsRepository } = await import('../db/groupsRepository');
    const { RulesRepository } = await import('../db/rulesRepository');
    const groupsRepository = new GroupsRepository(fakeClient as never);
    const rulesRepository = new RulesRepository(fakeClient as never);
    const group = await groupsRepository.upsertDiscoveredGroup(
      sourceAccountId,
      'export@g.us',
      'Export Group',
    );
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours',
      triggerType: 'auto_reply',
      config: AUTO_REPLY_CONFIG,
    });

    const res = await request(app)
      .get(`/api/backup/export?accountId=${sourceAccountId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.document.schemaVersion).toBe(1);
    expect(res.body.document.sourceAccountLabel).toBe('Source Account');
    expect(res.body.document.groups).toEqual([
      expect.objectContaining({ whatsappGroupJid: 'export@g.us', subject: 'Export Group' }),
    ]);

    const serialized = JSON.stringify(res.body.document).toLowerCase();
    expect(serialized).not.toMatch(/password|secret|servicerole|apikey|encryptionkey/);
  });

  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app)
      .get(`/api/backup/export?accountId=${sourceAccountId}`)
      .set('Cookie', cookie)
      .expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});

describe('backup routes — import preview/apply', () => {
  it('rejects POST without a CSRF token', async () => {
    const { cookie } = await login();
    await request(app)
      .post('/api/backup/import/preview')
      .set('Cookie', cookie)
      .send({ targetAccountId, document: {} })
      .expect(403);
  });

  it('404s an unknown target account', async () => {
    const { cookie, csrfToken } = await login();
    await request(app)
      .post('/api/backup/import/preview')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ targetAccountId: 'does-not-exist', document: {} })
      .expect(404);
  });

  it('400s a malformed or tampered backup document', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .post('/api/backup/import/preview')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        targetAccountId,
        document: {
          schemaVersion: 1,
          exportedAt: 'x',
          sourceAccountLabel: 'x',
          accountSettings: {},
          groups: [],
          contacts: [],
          presets: [],
          supabaseServiceRoleKey: 'leaked',
        },
      })
      .expect(400);
    expect(res.body.error).toBe('invalid_backup_document');
  });

  it('previews then applies a real export onto a matching target account', async () => {
    const { cookie, csrfToken } = await login();

    const { GroupsRepository } = await import('../db/groupsRepository');
    const groupsRepository = new GroupsRepository(fakeClient as never);
    const sourceGroup = await groupsRepository.upsertDiscoveredGroup(
      sourceAccountId,
      'roundtrip@g.us',
      'Roundtrip Group',
    );
    await groupsRepository.updateSettings(sourceGroup.id, {
      botEnabled: true,
      monitoringEnabled: true,
    });

    const exportRes = await request(app)
      .get(`/api/backup/export?accountId=${sourceAccountId}`)
      .set('Cookie', cookie)
      .expect(200);
    const document = exportRes.body.document;

    // The target account hasn't discovered this group yet — preview must report it unmatched.
    const previewBeforeDiscovery = await request(app)
      .post('/api/backup/import/preview')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ targetAccountId, document })
      .expect(200);
    const planGroupBefore = previewBeforeDiscovery.body.plan.groups.find(
      (g: { whatsappGroupJid: string }) => g.whatsappGroupJid === 'roundtrip@g.us',
    );
    expect(planGroupBefore).toMatchObject({ matched: false });

    await groupsRepository.upsertDiscoveredGroup(
      targetAccountId,
      'roundtrip@g.us',
      'Roundtrip Group (target)',
    );

    const preview = await request(app)
      .post('/api/backup/import/preview')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ targetAccountId, document })
      .expect(200);
    const planGroupAfter = preview.body.plan.groups.find(
      (g: { whatsappGroupJid: string }) => g.whatsappGroupJid === 'roundtrip@g.us',
    );
    expect(planGroupAfter).toMatchObject({ matched: true });

    const apply = await request(app)
      .post('/api/backup/import/apply')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ targetAccountId, document })
      .expect(200);
    expect(apply.body.result.groupsMatched).toBeGreaterThanOrEqual(1);

    const targetGroup = await groupsRepository.getByJid(targetAccountId, 'roundtrip@g.us');
    const targetSettings = await groupsRepository.getSettings(targetGroup!.id);
    expect(targetSettings?.botEnabled).toBe(true);
    expect(targetSettings?.monitoringEnabled).toBe(true);
  });
});
