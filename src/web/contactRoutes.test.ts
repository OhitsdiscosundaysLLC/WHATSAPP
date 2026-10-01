import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';

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
  const { checkDatabaseHealth, getSupabaseClient } = supabaseClientModule;
  fakeClient = getSupabaseClient() as unknown as FakeSupabaseClient;

  app = createServer({
    getWhatsAppStatus: () => accountManager.getAggregateStatus(),
    getDatabaseHealth: () => checkDatabaseHealth(),
    getAuthPersistence: () => accountManager.getStorageStatus(),
  });
  await accountManager.load();
});

afterAll(() => {
  delete process.env.WHATSAPP_ENABLED;
});

const VALID_RULE_BODY = {
  name: 'Hours auto-reply',
  phrases: ['hours', 'open'],
  matchMode: 'contains',
  cooldownSeconds: 0,
  actionType: 'SEND_MESSAGE',
  message: 'We are open 9-5.',
};

async function seedContact(jid: string): Promise<string> {
  const { ContactsRepository } = await import('../db/contactsRepository');
  const repo = new ContactsRepository(fakeClient as never);
  const contact = await repo.upsertDiscoveredContact('acct-seed', jid, undefined);
  return contact.id;
}

describe('contact routes — authentication', () => {
  it('rejects unauthenticated GET /api/contacts with 401', async () => {
    await request(app).get('/api/contacts').expect(401);
  });

  it('rejects unauthenticated PATCH settings with 401', async () => {
    await request(app)
      .patch('/api/contacts/some-id/settings')
      .send({ privateAiEnabled: true })
      .expect(401);
  });

  it('rejects unauthenticated rule creation with 401', async () => {
    await request(app).post('/api/contacts/some-id/rules').send(VALID_RULE_BODY).expect(401);
  });
});

describe('contact routes — listing and detail', () => {
  it('lists discovered contacts with settings and rule counts', async () => {
    const { cookie } = await login();
    const contactId = await seedContact('list-test@s.whatsapp.net');

    const res = await request(app).get('/api/contacts').set('Cookie', cookie).expect(200);
    const found = res.body.contacts.find((c: { id: string }) => c.id === contactId);
    expect(found).toBeDefined();
    expect(found.privateMonitoringEnabled).toBe(false);
    expect(found.privateAiEnabled).toBe(false);
    expect(found.ruleCount).toBe(0);
  });

  it('404s for an unknown contact id', async () => {
    const { cookie } = await login();
    await request(app).get('/api/contacts/does-not-exist').set('Cookie', cookie).expect(404);
  });

  it('returns a single contact with settings', async () => {
    const { cookie } = await login();
    const contactId = await seedContact('detail-test@s.whatsapp.net');

    const res = await request(app)
      .get(`/api/contacts/${contactId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.contact.id).toBe(contactId);
    expect(res.body.settings.privateAutoReplyEnabled).toBe(false);
  });
});

describe('contact routes — settings isolation', () => {
  it('updating one contact never affects another contact', async () => {
    const { cookie, csrfToken } = await login();
    const contactA = await seedContact('a@s.whatsapp.net');
    const contactB = await seedContact('b@s.whatsapp.net');

    await request(app)
      .patch(`/api/contacts/${contactA}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ privateAiEnabled: true, privateMonitoringEnabled: true })
      .expect(200);

    const resA = await request(app)
      .get(`/api/contacts/${contactA}`)
      .set('Cookie', cookie)
      .expect(200);
    const resB = await request(app)
      .get(`/api/contacts/${contactB}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(resA.body.settings.privateAiEnabled).toBe(true);
    expect(resB.body.settings.privateAiEnabled).toBe(false);
    expect(resB.body.settings.privateMonitoringEnabled).toBe(false);
  });

  it('accepts and persists dryRunEnabled (Dry Run mode), defaulting to false', async () => {
    const { cookie, csrfToken } = await login();
    const contactId = await seedContact('dry-run@s.whatsapp.net');

    const getRes = await request(app)
      .get(`/api/contacts/${contactId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(getRes.body.settings.dryRunEnabled).toBe(false);

    const patchRes = await request(app)
      .patch(`/api/contacts/${contactId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ dryRunEnabled: true })
      .expect(200);
    expect(patchRes.body.settings.dryRunEnabled).toBe(true);
  });
});

describe('contact routes — block/allowlist/displayName', () => {
  it('blocking a contact persists and never auto-enables automation', async () => {
    const { cookie, csrfToken } = await login();
    const contactId = await seedContact('block-test@s.whatsapp.net');

    const res = await request(app)
      .patch(`/api/contacts/${contactId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ blocked: true, displayName: 'Spammer' })
      .expect(200);

    expect(res.body.contact.blocked).toBe(true);
    expect(res.body.contact.displayName).toBe('Spammer');

    const settingsRes = await request(app)
      .get(`/api/contacts/${contactId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(settingsRes.body.settings.privateAiEnabled).toBe(false);
  });
});

describe('contact routes — rules', () => {
  it('creates an auto_reply rule and rejects an empty name', async () => {
    const { cookie, csrfToken } = await login();
    const contactId = await seedContact('rules-test@s.whatsapp.net');

    const created = await request(app)
      .post(`/api/contacts/${contactId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    expect(created.body.rule.triggerType).toBe('auto_reply');
    expect(created.body.rule.contactId).toBe(contactId);

    await request(app)
      .post(`/api/contacts/${contactId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...VALID_RULE_BODY, name: '' })
      .expect(400);
  });

  it('a rule created for contact A is 404 when accessed through contact B', async () => {
    const { cookie, csrfToken } = await login();
    const contactA = await seedContact('rule-a@s.whatsapp.net');
    const contactB = await seedContact('rule-b@s.whatsapp.net');

    const created = await request(app)
      .post(`/api/contacts/${contactA}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    const ruleId = created.body.rule.id;

    await request(app)
      .patch(`/api/contacts/${contactB}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ enabled: false })
      .expect(404);
    await request(app)
      .delete(`/api/contacts/${contactB}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(404);
  });

  it('enables/disables and deletes a rule through its own contact', async () => {
    const { cookie, csrfToken } = await login();
    const contactId = await seedContact('rule-toggle@s.whatsapp.net');
    const created = await request(app)
      .post(`/api/contacts/${contactId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    const ruleId = created.body.rule.id;

    const disabled = await request(app)
      .patch(`/api/contacts/${contactId}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.rule.enabled).toBe(false);

    await request(app)
      .delete(`/api/contacts/${contactId}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const list = await request(app)
      .get(`/api/contacts/${contactId}/rules`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.rules).toHaveLength(0);
  });
});
