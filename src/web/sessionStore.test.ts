import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessionStore';

describe('SessionStore', () => {
  it('creates a session with a unique id and csrf token', () => {
    const store = new SessionStore();
    const a = store.create();
    const b = store.create();
    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(b.csrfToken);
  });

  it('retrieves a session it created', () => {
    const store = new SessionStore();
    const session = store.create();
    expect(store.get(session.id)).toEqual(session);
  });

  it('returns undefined for an unknown session id', () => {
    const store = new SessionStore();
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('destroy() removes the session', () => {
    const store = new SessionStore();
    const session = store.create();
    store.destroy(session.id);
    expect(store.get(session.id)).toBeUndefined();
  });

  it('expires sessions after the configured TTL', async () => {
    const store = new SessionStore(10); // 10ms TTL
    const session = store.create();
    expect(store.get(session.id)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get(session.id)).toBeUndefined();
  });
});
