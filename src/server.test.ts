import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_PASSWORD = 'correct-horse-battery-staple';

let app: Express;
let authDir: string;

beforeAll(async () => {
  authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-server-test-'));

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal'; // keep test output focused on failures, not request logs
  process.env.DASHBOARD_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.WHATSAPP_ENABLED = 'false'; // no real sockets in this test suite
  process.env.WHATSAPP_AUTH_DIR = authDir;

  const { createServer } = await import('./server');
  const { accountManager } = await import('./whatsapp/accountManager');
  app = createServer({ getWhatsAppStatus: () => accountManager.getAggregateStatus() });
});

afterAll(async () => {
  await fs.rm(authDir, { recursive: true, force: true });
});

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
  const cookie = loginRes.headers['set-cookie']![0]!;

  const pageRes = await request(app).get('/').set('Cookie', cookie).expect(200);
  const match = /csrf-token" content="([^"]+)"/.exec(pageRes.text);
  if (!match) throw new Error('csrf token not found in dashboard HTML');
  return { cookie, csrfToken: match[1]! };
}

describe('GET /health', () => {
  it('is public (no auth required) and returns 200', async () => {
    await request(app).get('/health').expect(200);
  });

  it('never includes qr, pairingCode, credentials, or account identifiers', async () => {
    const res = await request(app).get('/health').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/qr/i);
    expect(text).not.toMatch(/pairingCode/i);
    expect(text).not.toMatch(/password/i);
    expect(res.body.components.whatsapp).not.toHaveProperty('qr');
  });
});

describe('unauthenticated access', () => {
  it('redirects GET / to /login', async () => {
    const res = await request(app).get('/').expect(302);
    expect(res.headers.location).toBe('/login');
  });

  it('serves GET /login directly (public)', async () => {
    await request(app).get('/login').expect(200);
  });

  it('rejects GET /api/accounts with 401 JSON (not a redirect — it is an API)', async () => {
    const res = await request(app).get('/api/accounts').expect(401);
    expect(res.body.error).toBe('authentication_required');
  });

  it('rejects POST /api/accounts with 401', async () => {
    await request(app).post('/api/accounts').send({ label: 'x' }).expect(401);
  });

  it('rejects the SSE pairing endpoint with 401', async () => {
    await request(app).get('/api/accounts/does-not-exist/events').expect(401);
  });
});

describe('login', () => {
  it('rejects an incorrect password with 401 and does not set a cookie', async () => {
    const res = await request(app).post('/login').send({ password: 'wrong' }).expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the correct password and sets an HttpOnly, SameSite=Lax cookie', async () => {
    const res = await request(app).post('/login').send({ password: ADMIN_PASSWORD }).expect(200);
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // NODE_ENV=test, not production
  });
});

describe('authenticated dashboard access', () => {
  it('serves the dashboard HTML with a CSRF token embedded', async () => {
    const { cookie, csrfToken } = await login();
    expect(cookie).toBeTruthy();
    expect(csrfToken).toHaveLength(64); // 32 random bytes, hex-encoded
  });

  it('GET /api/accounts succeeds with a valid session', async () => {
    const { cookie } = await login();
    const res = await request(app).get('/api/accounts').set('Cookie', cookie).expect(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe('CSRF protection on mutating routes', () => {
  it('rejects POST /api/accounts without an X-CSRF-Token header', async () => {
    const { cookie } = await login();
    const res = await request(app)
      .post('/api/accounts')
      .set('Cookie', cookie)
      .send({ label: 'No CSRF' })
      .expect(403);
    expect(res.body.error).toBe('csrf_check_failed');
  });

  it('rejects POST /api/accounts with a wrong CSRF token', async () => {
    const { cookie } = await login();
    await request(app)
      .post('/api/accounts')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'not-the-real-token')
      .send({ label: 'Bad CSRF' })
      .expect(403);
  });

  it('accepts POST /api/accounts with the correct CSRF token', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app)
      .post('/api/accounts')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ label: 'Front Desk' })
      .expect(201);
    expect(res.body.account.label).toBe('Front Desk');
    expect(res.body.account.id).toBeTruthy();
    // WHATSAPP_ENABLED=false in this suite — must not silently try to connect.
    expect(res.body.account.status.state).toBe('disabled');
  });

  it('does not require a CSRF token for safe (GET) requests', async () => {
    const { cookie } = await login();
    await request(app).get('/api/accounts').set('Cookie', cookie).expect(200);
  });
});

describe('account lifecycle API', () => {
  it('creates, lists, and removes an account', async () => {
    const { cookie, csrfToken } = await login();

    const createRes = await request(app)
      .post('/api/accounts')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ label: 'Lifecycle Test' })
      .expect(201);
    const id = createRes.body.account.id as string;

    const listRes = await request(app).get('/api/accounts').set('Cookie', cookie).expect(200);
    expect(listRes.body.accounts.some((a: { id: string }) => a.id === id)).toBe(true);

    await request(app)
      .delete(`/api/accounts/${id}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);

    const afterDelete = await request(app).get('/api/accounts').set('Cookie', cookie).expect(200);
    expect(afterDelete.body.accounts.some((a: { id: string }) => a.id === id)).toBe(false);
  });

  it('returns 404 for actions on an unknown account id', async () => {
    const { cookie, csrfToken } = await login();
    await request(app)
      .post('/api/accounts/not-a-real-id/reconnect')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(404);
    await request(app)
      .delete('/api/accounts/not-a-real-id')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(404);
  });

  it('GET /api/accounts/:id/events returns 404 for an unknown account', async () => {
    const { cookie } = await login();
    await request(app).get('/api/accounts/not-a-real-id/events').set('Cookie', cookie).expect(404);
  });

  it('rejects an invalid phone number for pairing-code requests', async () => {
    const { cookie, csrfToken } = await login();
    const createRes = await request(app)
      .post('/api/accounts')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ label: 'Phone Validation' })
      .expect(201);
    const id = createRes.body.account.id as string;

    await request(app)
      .post(`/api/accounts/${id}/pairing-code`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ phoneNumber: 'not-a-number' })
      .expect(400);
  });
});

describe('logout / session expiration', () => {
  it('logout clears the session so subsequent authenticated requests fail', async () => {
    const { cookie } = await login();
    await request(app).get('/api/accounts').set('Cookie', cookie).expect(200);

    await request(app).post('/logout').set('Cookie', cookie).expect(200);

    await request(app).get('/api/accounts').set('Cookie', cookie).expect(401);
  });

  it('an unrecognized session cookie is treated as unauthenticated', async () => {
    await request(app)
      .get('/api/accounts')
      .set('Cookie', 'wa_owner_session=totally-made-up-session-id')
      .expect(401);
  });
});

// This exhausts the shared, process-wide login rate limiter for this
// client — it must run last, after every other test that needs to log in.
describe('login rate limiting', () => {
  it('blocks repeated failed attempts from the same client', async () => {
    const agent = request.agent(app);
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await agent.post('/login').send({ password: 'still-wrong' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
