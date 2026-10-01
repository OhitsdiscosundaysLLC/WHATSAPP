interface Bucket {
  count: number;
  windowStart: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Simple fixed-window login rate limiter, keyed by client IP. Failures
 * accumulate; a successful login resets the counter. In-memory only — see
 * `SessionStore`'s doc comment on why that's an accepted trade-off here.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; maxAttempts?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? Date.now;
  }

  isBlocked(key: string): { blocked: boolean; retryAfterMs?: number } {
    const bucket = this.buckets.get(key);
    if (!bucket) return { blocked: false };

    const elapsed = this.now() - bucket.windowStart;
    if (elapsed > this.windowMs) {
      this.buckets.delete(key);
      return { blocked: false };
    }

    if (bucket.count >= this.maxAttempts) {
      return { blocked: true, retryAfterMs: this.windowMs - elapsed };
    }

    return { blocked: false };
  }

  recordFailure(key: string): void {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return;
    }
    bucket.count += 1;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export const loginRateLimiter = new LoginRateLimiter();
