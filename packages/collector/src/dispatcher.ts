import type { DatabaseSync } from 'node:sqlite';
import { DAY_MS, transaction, UNTIL_UNBLOCKED, utcDay, type Service } from '@tempo-match/catalog';
import type { Clock } from './clock.ts';
import {
  RateLimitedError,
  RefusedError,
  ResponseFormatError,
  UnauthorizedError,
  UnavailableError,
} from './errors.ts';
import { retryAfterMs, SECOND_MS } from './upstream.ts';

const FIRST_BACK_OFF_MS = 30 * SECOND_MS;
const MAX_BACK_OFF_MS = 60 * 60 * SECOND_MS;
const RATE_LIMIT_FALLBACK_MS = 30 * SECOND_MS;
const JITTER = 0.5;

export const CallKind = {
  Plain: 'plain',
  Recheck: 'recheck',
} as const;
export type CallKind = (typeof CallKind)[keyof typeof CallKind];

export interface Policy {
  service: Service;
  /** Wait from the end of one call to the start of the next. */
  spacingMs: number;
  dailyCalls: number;
  dailyRechecks: number;
}

/** Every call to one upstream service goes through its dispatcher. */
export interface Dispatcher {
  readonly service: Service;
  /**
   * Waits for the spacing after the previous call ended, reserves the call in the catalog, sends
   * it and stores what the answer means for later calls. Throws RefusedError without sending
   * while the service is banned or held or the UTC day's calls are spent.
   */
  call<T>(kind: CallKind, send: () => Promise<T>): Promise<T>;
  rechecksLeft(): number;
}

interface Row {
  day: number;
  calls: number;
  recheck_calls: number;
  banned_until: number;
  held_until: number;
  failures: number;
}

export function dispatcher(db: DatabaseSync, policy: Policy, clock: Clock, random = Math.random): Dispatcher {
  const { service } = policy;
  const read = db.prepare('SELECT day, calls, recheck_calls, banned_until, held_until, failures FROM upstream WHERE service = ?');
  const reserve = db.prepare('UPDATE upstream SET day = ?, calls = ?, recheck_calls = ? WHERE service = ?');
  const ban = db.prepare(
    'UPDATE upstream SET banned_until = max(banned_until, ?), ban_reason = ?, failures = ? WHERE service = ?',
  );
  const hold = db.prepare(
    'UPDATE upstream SET held_until = max(held_until, ?), hold_reason = ? WHERE service = ?',
  );
  const succeed = db.prepare('UPDATE upstream SET failures = 0 WHERE service = ?');

  // The previous process sent its last call before it exited, so a full gap from start keeps the
  // spacing across restarts.
  let lastEnd = clock.monotonic();
  let queue: Promise<unknown> = Promise.resolve();

  const row = () => read.get(service) as unknown as Row;

  function reserveCall(kind: CallKind) {
    transaction(db, () => {
      const now = clock.now();
      const today = utcDay(now);
      const stored = row();
      const fresh = stored.day !== today;
      const calls = fresh ? 0 : stored.calls;
      const rechecks = fresh ? 0 : stored.recheck_calls;

      if (stored.banned_until > now) {
        throw new RefusedError(service, stored.banned_until, 'banned');
      }
      if (stored.held_until > now) {
        throw new RefusedError(service, stored.held_until, 'held');
      }
      const tomorrow = (today + 1) * DAY_MS;
      if (calls >= policy.dailyCalls) {
        throw new RefusedError(service, tomorrow, 'daily calls spent');
      }
      if (kind === CallKind.Recheck && rechecks >= policy.dailyRechecks) {
        throw new RefusedError(service, tomorrow, 'daily re-checks spent');
      }
      reserve.run(today, calls + 1, rechecks + (kind === CallKind.Recheck ? 1 : 0), service);
    });
  }

  function storeFailure(err: unknown) {
    const now = clock.now();
    const failures = row().failures;
    if (err instanceof RateLimitedError) {
      const until = Math.min(now + retryAfterMs(err.retryAfter, now, RATE_LIMIT_FALLBACK_MS), UNTIL_UNBLOCKED);
      ban.run(until, 'HTTP 429', failures, service);
      console.error(`${service} answered HTTP 429, no calls until ${new Date(until).toISOString()}`);
      return;
    }
    if (err instanceof UnavailableError) {
      const backOff = Math.min(FIRST_BACK_OFF_MS * 2 ** failures, MAX_BACK_OFF_MS);
      const until = now + Math.round(backOff * (1 + JITTER * (2 * random() - 1)));
      ban.run(until, err.message, failures + 1, service);
      console.error(`${err.message}, no calls until ${new Date(until).toISOString()}`);
      return;
    }
    if (err instanceof UnauthorizedError || err instanceof ResponseFormatError) {
      hold.run(UNTIL_UNBLOCKED, err.message, service);
      console.error(`${err.message}, no calls until an operator unblocks ${service}`);
    }
  }

  async function run<T>(kind: CallKind, send: () => Promise<T>): Promise<T> {
    const wait = lastEnd + policy.spacingMs - clock.monotonic();
    if (wait > 0) {
      await clock.sleep(wait);
    }
    reserveCall(kind);

    try {
      const result = await send();
      succeed.run(service);
      return result;
    } catch (err) {
      storeFailure(err);
      throw err;
    } finally {
      lastEnd = clock.monotonic();
    }
  }

  return {
    service,
    call(kind, send) {
      const result = queue.then(() => run(kind, send));
      queue = result.catch(() => {});
      return result;
    },
    rechecksLeft() {
      const stored = row();
      const used = stored.day === utcDay(clock.now()) ? stored.recheck_calls : 0;
      return Math.max(policy.dailyRechecks - used, 0);
    },
  };
}
