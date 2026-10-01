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

afterAll(() => {
  delete process.env.WHATSAPP_ENABLED;
});

const VALID_RULE_BODY = {
  name: 'Five people congratulate',
  phrases: ['congrats', 'congratulations'],
  matchMode: 'contains',
  threshold: 5,
  cooldownSeconds: 60,
  actionType: 'SEND_MESSAGE',
  message: 'Thanks everyone!',
};

async function seedGroup(jid: string, subject: string): Promise<string> {
  const { GroupsRepository } = await import('../db/groupsRepository');
  const repo = new GroupsRepository(fakeClient as never);
  const group = await repo.upsertDiscoveredGroup('acct-seed', jid, subject);
  return group.id;
}

describe('group routes — authentication', () => {
  it('rejects unauthenticated GET /api/groups with 401', async () => {
    await request(app).get('/api/groups').expect(401);
  });

  it('rejects unauthenticated PATCH settings with 401', async () => {
    await request(app).patch('/api/groups/some-id/settings').send({ botEnabled: true }).expect(401);
  });

  it('rejects unauthenticated rule creation with 401', async () => {
    await request(app).post('/api/groups/some-id/rules').send(VALID_RULE_BODY).expect(401);
  });
});

describe('group routes — listing and detail', () => {
  it('lists discovered groups with settings and rule counts', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('list-test@g.us', 'List Test Group');

    const res = await request(app).get('/api/groups').set('Cookie', cookie).expect(200);
    const found = res.body.groups.find((g: { id: string }) => g.id === groupId);
    expect(found).toBeDefined();
    expect(found.botEnabled).toBe(false);
    expect(found.monitoringEnabled).toBe(false);
    expect(found.ruleCount).toBe(0);
  });

  it('returns 404 for an unknown group id', async () => {
    const { cookie } = await login();
    await request(app).get('/api/groups/does-not-exist').set('Cookie', cookie).expect(404);
  });

  it('returns the group and its settings on detail', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('detail-test@g.us', 'Detail Test Group');

    const res = await request(app).get(`/api/groups/${groupId}`).set('Cookie', cookie).expect(200);
    expect(res.body.group.subject).toBe('Detail Test Group');
    expect(res.body.settings.botEnabled).toBe(false);
  });
});

describe('group routes — settings, CSRF, and isolation', () => {
  it('rejects PATCH settings without a CSRF token', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('csrf-test@g.us', 'CSRF Test Group');
    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .send({ botEnabled: true })
      .expect(403);
    expect(res.body.error).toBe('csrf_check_failed');
  });

  it('updates settings with a valid CSRF token', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('csrf-ok-test@g.us', 'CSRF OK Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ botEnabled: true, monitoringEnabled: true })
      .expect(200);

    expect(res.body.settings.botEnabled).toBe(true);
    expect(res.body.settings.monitoringEnabled).toBe(true);
  });

  it("changing one group's settings never affects another group", async () => {
    const { cookie, csrfToken } = await login();
    const groupA = await seedGroup('iso-a@g.us', 'Isolation A');
    const groupB = await seedGroup('iso-b@g.us', 'Isolation B');

    await request(app)
      .patch(`/api/groups/${groupA}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ botEnabled: true })
      .expect(200);

    const resB = await request(app).get(`/api/groups/${groupB}`).set('Cookie', cookie).expect(200);
    expect(resB.body.settings.botEnabled).toBe(false);
  });
});

describe('group routes — rule CRUD', () => {
  it('creates a rule from the friendly form shape (no raw JSON required)', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('rule-create@g.us', 'Rule Create Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);

    expect(res.body.rule.name).toBe('Five people congratulate');
    expect(res.body.rule.config.threshold).toBe(5);
    expect(res.body.rule.config.qualify.phrases).toEqual(['congrats', 'congratulations']);
  });

  it('rejects a rule with no qualifying phrases', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('rule-invalid@g.us', 'Rule Invalid Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...VALID_RULE_BODY, phrases: [] })
      .expect(400);

    expect(res.body.error).toBe('invalid_rule_config');
  });

  it('rejects a rule creation request without a name', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('rule-noname@g.us', 'Rule No Name Group');

    await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...VALID_RULE_BODY, name: '' })
      .expect(400);
  });

  it('enables and disables a rule', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('rule-toggle@g.us', 'Rule Toggle Group');
    const createRes = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    const ruleId = createRes.body.rule.id;

    const disableRes = await request(app)
      .patch(`/api/groups/${groupId}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ enabled: false })
      .expect(200);
    expect(disableRes.body.rule.enabled).toBe(false);
  });

  it('deletes a rule', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('rule-delete@g.us', 'Rule Delete Group');
    const createRes = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    const ruleId = createRes.body.rule.id;

    await request(app)
      .delete(`/api/groups/${groupId}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const listRes = await request(app)
      .get(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .expect(200);
    expect(listRes.body.rules).toHaveLength(0);
  });

  it("a rule created under one group is never returned for another group's rule id", async () => {
    const { cookie, csrfToken } = await login();
    const groupA = await seedGroup('rule-iso-a@g.us', 'Rule Isolation A');
    const groupB = await seedGroup('rule-iso-b@g.us', 'Rule Isolation B');
    const createRes = await request(app)
      .post(`/api/groups/${groupA}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send(VALID_RULE_BODY)
      .expect(201);
    const ruleId = createRes.body.rule.id;

    await request(app)
      .delete(`/api/groups/${groupB}/rules/${ruleId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(404);
  });
});

describe('group routes — Supabase not configured', () => {
  it('returns 503 with a clear message when Supabase is not configured', async () => {
    isSupabaseConfiguredMock.mockReturnValueOnce(false);
    const { cookie } = await login();
    const res = await request(app).get('/api/groups').set('Cookie', cookie).expect(503);
    expect(res.body.error).toBe('supabase_not_configured');
  });
});

describe('group routes — auto_reply and moderation rule creation (Phase 6+)', () => {
  it('creates a deterministic auto_reply rule from the friendly form', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('auto-reply-create@g.us', 'Auto Reply Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Hours auto-reply',
        triggerType: 'auto_reply',
        classifier: 'deterministic',
        matchMode: 'contains',
        phrases: ['hours'],
        actionType: 'SEND_MESSAGE',
        message: 'We are open 9-5.',
        cooldownSeconds: 0,
      })
      .expect(201);

    expect(res.body.rule.triggerType).toBe('auto_reply');
    expect(res.body.rule.config.qualify).toMatchObject({
      classifier: 'deterministic',
      phrases: ['hours'],
    });
  });

  it('creates an AI auto_reply rule with AI_REPLY action', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('auto-reply-ai@g.us', 'AI Auto Reply Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'AI auto-reply',
        triggerType: 'auto_reply',
        classifier: 'ai',
        aiInstructions: 'asks about opening hours',
        actionType: 'AI_REPLY',
        cooldownSeconds: 0,
      })
      .expect(201);

    expect(res.body.rule.config.qualify).toMatchObject({
      classifier: 'ai',
      aiInstructions: 'asks about opening hours',
    });
    expect(res.body.rule.config.action).toMatchObject({ type: 'AI_REPLY' });
  });

  it('creates a moderation rule with banned phrases', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('moderation-create@g.us', 'Moderation Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'No bad words',
        triggerType: 'moderation',
        bannedPhrases: ['bad word'],
        actionType: 'WARN',
        message: 'Please watch your language.',
        cooldownSeconds: 0,
      })
      .expect(201);

    expect(res.body.rule.triggerType).toBe('moderation');
    expect(res.body.rule.config.qualify.bannedPhrases).toEqual(['bad word']);
    expect(res.body.rule.config.action).toMatchObject({ type: 'WARN' });
  });

  it('rejects a moderation rule whose action is DELETE_MESSAGE with an invalid shape gracefully (still a valid shape, just unauthorized at execution time)', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('moderation-delete@g.us', 'Moderation Delete Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Delete spam',
        triggerType: 'moderation',
        bannedPhrases: ['spam'],
        actionType: 'DELETE_MESSAGE',
        cooldownSeconds: 0,
      })
      .expect(201);

    expect(res.body.rule.config.action).toEqual({ type: 'DELETE_MESSAGE' });
  });

  it('rejects an unknown trigger_type by falling back to response_threshold validation', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('bad-trigger@g.us', 'Bad Trigger Group');

    const res = await request(app)
      .post(`/api/groups/${groupId}/rules`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'x', triggerType: 'not_a_real_type', phrases: [], threshold: 1 })
      .expect(400);
    expect(res.body.error).toBe('invalid_rule_config');
  });
});

describe('group routes — extended settings fields (Phase 6+)', () => {
  it('accepts and persists the new AI/archive/moderation settings fields', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('extended-settings@g.us', 'Extended Settings Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        aiEnabled: true,
        autoReplyEnabled: true,
        aiAutoReplyEnabled: true,
        aiSemanticClassificationEnabled: true,
        aiCooldownSeconds: 120,
        aiMaxResponsesPerHour: 10,
        deletedMessageArchiveEnabled: true,
        deletedMessageRetentionDays: 30,
        viewOnceHandlingEnabled: true,
        moderationEnabled: true,
        moderationDestructiveActionsEnabled: true,
      })
      .expect(200);

    expect(res.body.settings).toMatchObject({
      aiEnabled: true,
      autoReplyEnabled: true,
      aiAutoReplyEnabled: true,
      aiSemanticClassificationEnabled: true,
      aiCooldownSeconds: 120,
      aiMaxResponsesPerHour: 10,
      deletedMessageArchiveEnabled: true,
      deletedMessageRetentionDays: 30,
      viewOnceHandlingEnabled: true,
      moderationEnabled: true,
      moderationDestructiveActionsEnabled: true,
    });
  });

  it('accepts and persists dryRunEnabled (Dry Run mode)', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('dry-run@g.us', 'Dry Run Group');

    const getRes = await request(app)
      .get(`/api/groups/${groupId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(getRes.body.settings.dryRunEnabled).toBe(false);

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ dryRunEnabled: true })
      .expect(200);
    expect(res.body.settings.dryRunEnabled).toBe(true);
  });

  it('accepts and persists VIP/Never Auto Reply/Never Moderate/owner notes', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('tags@g.us', 'Tags Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        vip: true,
        neverAutoReply: true,
        neverModerate: true,
        ownerNotes: 'Handle with care — long-time client.',
      })
      .expect(200);
    expect(res.body.settings).toMatchObject({
      vip: true,
      neverAutoReply: true,
      neverModerate: true,
      ownerNotes: 'Handle with care — long-time client.',
    });
  });

  it('accepts and persists quiet hours configuration', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('quiet@g.us', 'Quiet Hours Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        quietHoursEnabled: true,
        quietHoursTimezone: 'America/New_York',
        quietHoursDays: [1, 2, 3, 4, 5],
        quietHoursStartMinutes: 17 * 60,
        quietHoursEndMinutes: 9 * 60,
      })
      .expect(200);
    expect(res.body.settings).toMatchObject({
      quietHoursEnabled: true,
      quietHoursTimezone: 'America/New_York',
      quietHoursDays: [1, 2, 3, 4, 5],
      quietHoursStartMinutes: 1020,
      quietHoursEndMinutes: 540,
    });
  });

  it('filters out-of-range values from quietHoursDays rather than storing them', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('quiet-filter@g.us', 'Quiet Filter Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ quietHoursDays: [1, 2, 99, -1, 'nope'] })
      .expect(200);
    expect(res.body.settings.quietHoursDays).toEqual([1, 2]);
  });

  it('rejects an invalid deletedMessageAlertMode (ignored, not applied)', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('alert-mode@g.us', 'Alert Mode Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ deletedMessageAlertMode: 'not_a_real_mode' })
      .expect(200);
    expect(res.body.settings.deletedMessageAlertMode).toBe('archive_only');
  });

  it('accepts a valid deletedMessageAlertMode', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('alert-mode-valid@g.us', 'Alert Mode Valid Group');

    const res = await request(app)
      .patch(`/api/groups/${groupId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ deletedMessageAlertMode: 'both' })
      .expect(200);
    expect(res.body.settings.deletedMessageAlertMode).toBe('both');
  });
});

describe('group routes — Human Takeover', () => {
  it('rejects without a CSRF token', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('takeover-csrf@g.us', 'Takeover CSRF Group');
    await request(app)
      .post(`/api/groups/${groupId}/human-takeover`)
      .set('Cookie', cookie)
      .send({ durationMinutes: 30 })
      .expect(403);
  });

  it('rejects a request with neither durationMinutes nor resume', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('takeover-invalid@g.us', 'Takeover Invalid Group');
    await request(app)
      .post(`/api/groups/${groupId}/human-takeover`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(400);
  });

  it('starts a takeover for the given duration, then resumes automation early', async () => {
    const { cookie, csrfToken } = await login();
    const groupId = await seedGroup('takeover@g.us', 'Takeover Group');

    const startRes = await request(app)
      .post(`/api/groups/${groupId}/human-takeover`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ durationMinutes: 30 })
      .expect(200);
    expect(startRes.body.settings.humanTakeoverUntil).toBeTruthy();
    expect(new Date(startRes.body.settings.humanTakeoverUntil).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const resumeRes = await request(app)
      .post(`/api/groups/${groupId}/human-takeover`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ resume: true })
      .expect(200);
    expect(resumeRes.body.settings.humanTakeoverUntil).toBeFalsy();
  });
});

describe('group routes — deleted messages and media archive', () => {
  it('rejects unauthenticated access to deleted messages', async () => {
    await request(app).get('/api/groups/some-id/deleted-messages').expect(401);
  });

  it('lists deleted messages for a group (empty when none archived)', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('deleted-list@g.us', 'Deleted List Group');
    const res = await request(app)
      .get(`/api/groups/${groupId}/deleted-messages`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.messages).toEqual([]);
  });

  it('lists archived media for a group (empty when none archived)', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('media-list@g.us', 'Media List Group');
    const res = await request(app)
      .get(`/api/groups/${groupId}/media-archive`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.media).toEqual([]);
  });

  it('returns 404 for a media id that does not exist', async () => {
    const { cookie } = await login();
    const groupId = await seedGroup('media-404@g.us', 'Media 404 Group');
    await request(app)
      .get(`/api/groups/${groupId}/media-archive/does-not-exist/url`)
      .set('Cookie', cookie)
      .expect(404);
  });
});
