const RATE_LIMIT = /^(\d+)\/(\d+)$/;
const SECOND_MS = 1000;

export interface RateLimit {
  count: number;
  windowSeconds: number;
}

/** Returns the seconds until a request is allowed again, or undefined to allow it now. */
export type RateLimiter = () => number | undefined;

export class InvalidRateLimitError extends Error {
  constructor(spec: string) {
    super(`SIMULATE_RATE_LIMIT must be <count>/<seconds> with positive integers, such as 10/10, not "${spec}"`);
    this.name = 'InvalidRateLimitError';
  }
}

export function parseRateLimit(spec: string): RateLimit {
  const match = RATE_LIMIT.exec(spec);
  const count = Number(match?.[1]);
  const windowSeconds = Number(match?.[2]);
  if (!match || !isPositiveSafe(count) || !isPositiveSafe(windowSeconds * SECOND_MS)) {
    throw new InvalidRateLimitError(spec);
  }
  return { count, windowSeconds };
}

function isPositiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function fixedWindow(limit: RateLimit, now: () => number = Date.now): RateLimiter {
  const windowMs = limit.windowSeconds * SECOND_MS;
  let windowStart = -Infinity;
  let used = 0;
  return () => {
    const time = now();
    if (time >= windowStart + windowMs) {
      windowStart = time;
      used = 0;
    }

    used += 1;
    if (used <= limit.count) {
      return undefined;
    }
    return Math.ceil((windowStart + windowMs - time) / SECOND_MS);
  };
}
