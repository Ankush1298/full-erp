import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import {
  DIRECTORY_RATE_LIMIT,
  DIRECTORY_RATE_MAX_KEYS,
  DIRECTORY_RATE_WINDOW_MS,
  createDirectoryLimiter,
} from '../../src/modules/students/student-directory.routes.js';

function make(o: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
  const clock = { ms: 1_000_000 };
  const limiter = new FixedWindowLimiter({
    limit: o.limit ?? 3,
    windowMs: o.windowMs ?? 60_000,
    maxKeys: o.maxKeys ?? 100,
    now: () => clock.ms,
  });
  return { limiter, clock };
}

describe('FixedWindowLimiter', () => {
  it('allows exactly `limit` requests per key per window and then answers with whole seconds to wait', () => {
    const { limiter, clock } = make();
    expect([limiter.take('u'), limiter.take('u'), limiter.take('u')]).toEqual([0, 0, 0]);
    expect(limiter.take('u')).toBe(60);
    clock.ms += 10_500;
    expect(limiter.take('u')).toBe(50); // ceil(49.5)
    clock.ms += 49_000;
    expect(limiter.take('u')).toBe(1); // never 0 while refused
  });

  it('a refused request is not counted: the window still resets on schedule', () => {
    const { limiter, clock } = make({ limit: 1 });
    expect(limiter.take('u')).toBe(0);
    for (let i = 0; i < 50; i++) expect(limiter.take('u')).toBeGreaterThan(0);
    clock.ms += 60_000; // exactly the window: reset
    expect(limiter.take('u')).toBe(0);
  });

  it('resets after the window and keys are independent', () => {
    const { limiter, clock } = make({ limit: 2 });
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a')).toBeGreaterThan(0);
    expect(limiter.take('b')).toBe(0); // another caller is unaffected
    clock.ms += 60_001;
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeGreaterThan(0);
  });

  it('keeps memory bounded: expired entries are swept, and when every window is live a NEW key is refused (no eviction)', () => {
    const { limiter, clock } = make({ limit: 1, maxKeys: 3 });
    expect(limiter.take('a')).toBe(0);
    clock.ms += 1_000;
    expect(limiter.take('b')).toBe(0);
    expect(limiter.take('c')).toBe(0);
    expect(limiter.size).toBe(3);
    // full of live windows: a new key waits until the earliest one (a) expires, and nobody's budget is reset
    expect(limiter.take('d')).toBe(59);
    expect(limiter.size).toBe(3);
    expect(limiter.take('a')).toBeGreaterThan(0); // a was NOT evicted: still limited
    clock.ms += 59_000; // a expires
    expect(limiter.take('d')).toBe(0); // sweep freed room
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it('size never exceeds maxKeys under a flood of distinct keys', () => {
    const { limiter, clock } = make({ maxKeys: 50 });
    for (let i = 0; i < 5_000; i++) {
      limiter.take(`k${i}`);
      if (i % 100 === 0) clock.ms += 7_000;
      expect(limiter.size).toBeLessThanOrEqual(50);
    }
  });

  it('rejects nonsensical configuration', () => {
    for (const bad of [{ limit: 0 }, { windowMs: 0 }, { maxKeys: 0 }, { limit: 1.5 }]) {
      expect(() => make(bad)).toThrow();
    }
  });
});

describe('the student directory limit', () => {
  it('is 30 requests per user per 60 seconds, bounded to 10,000 tracked users', () => {
    expect([DIRECTORY_RATE_LIMIT, DIRECTORY_RATE_WINDOW_MS, DIRECTORY_RATE_MAX_KEYS]).toEqual([
      30, 60_000, 10_000,
    ]);
    const clock = { ms: 5_000_000 };
    const limiter = createDirectoryLimiter(() => clock.ms);
    for (let i = 0; i < 30; i++) expect(limiter.take('t:u')).toBe(0);
    expect(limiter.take('t:u')).toBe(60);
  });
});
