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

describe('preset routes', () => {
  it('rejects unauthenticated access with 401', async () => {
    await request(app).get('/api/group-presets').expect(401);
  });

  it('returns empty presets when none exist', async () => {
    const { cookie } = await login();
    const res = await request(app)
      .get('/api/group-presets?accountId=acct-empty')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.presets).toEqual([]);
  });

  it('rejects POST without a CSRF token', async () => {
    const { cookie } = await login();
    await request(app)
      .post('/api/group-presets')
      .set('Cookie', cookie)
      .send({ accountId: 'acct-1', name: 'Business', settings: { botEnabled: true } })
      .expect(403);
  });

  it('creates, lists, updates, duplicates, and deletes a preset', async () => {
    const { cookie, csrfToken } = await login();

    const created = await request(app)
      .post('/api/group-presets')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        accountId: 'acct-preset',
        name: 'Business',
        settings: { botEnabled: true, autoReplyEnabled: true, humanTakeoverUntil: '2026-01-01' },
      })
      .expect(201);
    const presetId = created.body.preset.id;
    expect(created.body.preset.settings.humanTakeoverUntil).toBeUndefined();

    const list = await request(app)
      .get('/api/group-presets?accountId=acct-preset')
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.presets).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/group-presets/${presetId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Business Hours' })
      .expect(200);
    expect(updated.body.preset.name).toBe('Business Hours');

    const duplicated = await request(app)
      .post(`/api/group-presets/${presetId}/duplicate`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(201);
    expect(duplicated.body.preset.id).not.toBe(presetId);
    expect(duplicated.body.preset.name).toBe('Business Hours (copy)');

    await request(app)
      .delete(`/api/group-presets/${presetId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const afterDelete = await request(app)
      .get('/api/group-presets?accountId=acct-preset')
      .set('Cookie', cookie)
      .expect(200);
    expect(afterDelete.body.presets).toHaveLength(1); // the duplicate remains
  });

  it('404s updating/deleting an unknown preset', async () => {
    const { cookie, csrfToken } = await login();
    await request(app)
      .patch('/api/group-presets/does-not-exist')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'x' })
      .expect(404);
    await request(app)
      .delete('/api/group-presets/does-not-exist')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(404);
  });

  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app)
      .get('/api/group-presets?accountId=acct-1')
      .set('Cookie', cookie)
      .expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});

describe('group routes — apply-preset', () => {
  it('applies a preset’s settings onto a group, never a live link', async () => {
    const { cookie, csrfToken } = await login();

    const { GroupsRepository } = await import('../db/groupsRepository');
    const groupsRepository = new GroupsRepository(fakeClient as never);
    const group = await groupsRepository.upsertDiscoveredGroup(
      'acct-apply',
      'apply@g.us',
      'Apply Group',
    );

    const createdPreset = await request(app)
      .post('/api/group-presets')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        accountId: 'acct-apply',
        name: 'Business',
        settings: { botEnabled: true, autoReplyEnabled: true },
      })
      .expect(201);
    const presetId = createdPreset.body.preset.id;

    const applied = await request(app)
      .post(`/api/groups/${group.id}/apply-preset`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ presetId })
      .expect(200);
    expect(applied.body.settings).toMatchObject({ botEnabled: true, autoReplyEnabled: true });

    // Editing the preset afterward must never retroactively change the group.
    await request(app)
      .patch(`/api/group-presets/${presetId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ settings: { botEnabled: false, autoReplyEnabled: false } })
      .expect(200);

    const groupSettings = await groupsRepository.getSettings(group.id);
    expect(groupSettings).toMatchObject({ botEnabled: true, autoReplyEnabled: true });
  });

  it('404s applying an unknown preset to a real group', async () => {
    const { cookie, csrfToken } = await login();
    const { GroupsRepository } = await import('../db/groupsRepository');
    const groupsRepository = new GroupsRepository(fakeClient as never);
    const group = await groupsRepository.upsertDiscoveredGroup(
      'acct-apply-404',
      'apply-404@g.us',
      'Apply 404 Group',
    );

    await request(app)
      .post(`/api/groups/${group.id}/apply-preset`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ presetId: 'does-not-exist' })
      .expect(404);
  });
});
