/** Takes one call from the budget, or returns false when none is left. */
export type CallBudget = () => boolean;

/** Allows `burst` calls at once, refilled at `callsPerMinute`. */
export function tokenBucket(callsPerMinute: number, burst: number, now: () => number): CallBudget {
  const callsPerMs = callsPerMinute / 60_000;
  let tokens = burst;
  let refilledAt = now();
  return () => {
    const time = now();
    tokens = Math.min(burst, tokens + (time - refilledAt) * callsPerMs);
    refilledAt = time;
    if (tokens < 1) {
      return false;
    }

    tokens -= 1;
    return true;
  };
}
