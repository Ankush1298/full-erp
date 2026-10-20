export interface FixedWindowLimiterOptions {
  /** Requests allowed per key per window. */
  limit: number;
  windowMs: number;
  /** Hard cap on tracked keys. Expired entries are swept first; a NEW key is then refused (fail closed), never an old one evicted. */
  maxKeys: number;
  now?: () => number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter for AUTHENTICATED routes, keyed by the caller (for example `<tenant>:<user>`). It is
 * deliberately separate from LoginRateLimiter, which counts login FAILURES per IP and account and is not a general
 * request limiter.
 *
 * SINGLE INSTANCE ONLY. The counters live in this process: with N backend instances a caller gets up to N times the
 * limit, and a restart resets every window. It therefore must not be described as protecting a multi-instance
 * deployment; such a deployment needs a shared store (PostgreSQL or Redis) behind the same `take` interface, which is a
 * separate infrastructure decision. Fixed windows also allow up to 2 x limit requests across a window boundary.
 *
 * Memory is bounded by `maxKeys`: keys are authenticated user ids, so the realistic population is the number of staff.
 * When the table is full of live windows a new key is refused until one expires (a clear 429, not silent eviction that
 * would reset someone's budget).
 */
export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(o: FixedWindowLimiterOptions) {
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) throw new Error('limit must be >= 1');
    if (!Number.isSafeInteger(o.windowMs) || o.windowMs < 1)
      throw new Error('windowMs must be >= 1');
    if (!Number.isSafeInteger(o.maxKeys) || o.maxKeys < 1) throw new Error('maxKeys must be >= 1');
    this.limit = o.limit;
    this.windowMs = o.windowMs;
    this.maxKeys = o.maxKeys;
    this.now = o.now ?? Date.now;
  }

  /**
   * Counts one request for `key`. Returns 0 when it may proceed, otherwise the whole seconds (>= 1) the caller must wait
   * before the window resets. A refused request is not counted again.
   */
  take(key: string): number {
    const t = this.now();
    const e = this.entries.get(key);
    if (e && e.resetAt > t) {
      if (e.count >= this.limit) return Math.max(1, Math.ceil((e.resetAt - t) / 1000));
      e.count += 1;
      return 0;
    }
    if (e) this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) {
      for (const [k, v] of this.entries) if (v.resetAt <= t) this.entries.delete(k);
      if (this.entries.size >= this.maxKeys) {
        // Every window has the same length, so the first entry in insertion order is the one that expires first.
        const first = this.entries.values().next().value as Entry;
        return Math.max(1, Math.ceil((first.resetAt - t) / 1000));
      }
    }
    this.entries.set(key, { count: 1, resetAt: t + this.windowMs });
    return 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
