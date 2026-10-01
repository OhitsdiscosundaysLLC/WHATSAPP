import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './loginRateLimiter';

describe('LoginRateLimiter', () => {
  it('allows attempts under the limit', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(false);
  });

  it('blocks once the max attempt count is reached', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    const result = limiter.isBlocked('1.2.3.4');
    expect(result.blocked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks each key independently', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1 });
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(true);
    expect(limiter.isBlocked('5.6.7.8').blocked).toBe(false);
  });

  it('reset() clears the block for a key', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1 });
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(true);
    limiter.reset('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(false);
  });

  it('clears the window once it elapses', () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000, now: () => now });
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(true);
    now = 2000;
    expect(limiter.isBlocked('1.2.3.4').blocked).toBe(false);
  });
});
