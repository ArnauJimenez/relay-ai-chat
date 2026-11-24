export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume: (key: string) => RateLimitDecision;
}

interface RateLimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
}

/**
 * Fixed-window, in-memory limiter. Counters live in this process, which is fine for a
 * single Render instance; move them to a shared store before scaling horizontally.
 */
export function createRateLimiter({ windowMs, max, now = Date.now }: RateLimiterOptions): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return {
    consume(key) {
      const current = now();

      if (current - lastSweep >= windowMs) {
        for (const [windowKey, window] of windows) {
          if (window.resetAt <= current) {
            windows.delete(windowKey);
          }
        }
        lastSweep = current;
      }

      const window = windows.get(key);
      if (!window || window.resetAt <= current) {
        windows.set(key, { count: 1, resetAt: current + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (window.count < max) {
        window.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - current) / 1000)),
      };
    },
  };
}
