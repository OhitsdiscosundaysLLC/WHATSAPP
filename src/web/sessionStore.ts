import { randomBytes } from 'crypto';

export interface SessionRecord {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * In-memory owner-session store. Deliberately simple for an interim,
 * single-owner authentication system (see docs/SECURITY.md): sessions live
 * only for the life of the process, so a restart signs everyone out. No
 * database is involved — this is not meant to scale past one admin user
 * and is explicitly documented as a placeholder for Supabase Auth later.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      id: randomToken(),
      csrfToken: randomToken(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  /** Returns the session if it exists and hasn't expired (lazily evicting it if it has). */
  get(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (Date.now() > record.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return record;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  get ttl(): number {
    return this.ttlMs;
  }
}

export const sessionStore = new SessionStore();
