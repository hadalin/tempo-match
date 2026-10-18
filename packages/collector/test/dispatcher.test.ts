import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';
import { DAY_MS, UNTIL_UNBLOCKED } from '@tempo-match/catalog';
import { runCommand } from '../src/commands.ts';
import { CallKind, dispatcher, type Policy } from '../src/dispatcher.ts';
import {
  RateLimitedError,
  RefusedError,
  ResponseFormatError,
  UnauthorizedError,
  UnavailableError,
  UpstreamError,
} from '../src/errors.ts';
import { SPOTIFY } from '../src/policies.ts';
import { Verification } from '../src/status.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock, NOW, type FakeClock } from './fake-clock.ts';

const SMALL: Policy = { service: 'spotify', spacingMs: 3000, spacingJitter: 0, dailyCalls: 5, dailyRechecks: 2 };

function setup(policy = SMALL, random = () => 0.5) {
  const { db } = memoryCatalog();
  const clock = fakeClock();
  const sends: number[] = [];
  const calls = dispatcher(db, policy, clock, random);
  const send = (outcome?: Error, durationMs = 0) => async () => {
    sends.push(clock.now());
    clock.advance(durationMs);
    if (outcome) {
      throw outcome;
    }
    return 'ok';
  };
  return { db, clock, sends, calls, send };
}

function upstream(db: DatabaseSync) {
  return { ...db.prepare("SELECT * FROM upstream WHERE service = 'spotify'").get() };
}

function admin(db: DatabaseSync, clock: FakeClock, ...args: string[]) {
  return runCommand(args, { db, path: ':memory:', market: 'US', verification: Verification.Checked, now: clock.now() });
}

test('spaces calls from the end of the previous call, also the first one after a start', async () => {
  const { sends, calls, send } = setup();

  await calls.call(CallKind.Plain, send(undefined, 4000));
  await calls.call(CallKind.Plain, send());

  assert.deepEqual(sends, [NOW + 3000, NOW + 3000 + 4000 + 3000]);
});

test('sends one call at a time, in order', async () => {
  const { sends, calls, send } = setup();

  const results = await Promise.all([1, 2, 3].map(() => calls.call(CallKind.Plain, send(undefined, 1000))));

  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.deepEqual(sends, [NOW + 3000, NOW + 7000, NOW + 11000]);
});

function seeded(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

test('Spotify spaces calls at random, 43.2-129.6 s apart, averaging 86.4 s', async () => {
  const { sends, calls, send } = setup(SPOTIFY, seeded(1));

  for (let i = 0; i < 1000; i++) {
    await calls.call(CallKind.Plain, send());
  }

  const gaps = sends.slice(1).map((start, i) => start - sends[i]);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  assert.ok(new Set(gaps).size > 900);
  assert.ok(gaps.every((gap) => gap >= 43_200 && gap <= 129_600));
  assert.ok(Math.abs(mean - 86_400) < 2_000, `mean gap ${mean}`);
  assert.equal(SPOTIFY.dailyCalls * SPOTIFY.spacingMs, DAY_MS);
});

test('Spotify gaps reach both bounds', async () => {
  const draws = [0, 1];
  const { sends, calls, send } = setup(SPOTIFY, () => draws.shift()!);

  for (let i = 0; i < 2; i++) {
    await calls.call(CallKind.Plain, send(undefined, 500));
  }

  assert.deepEqual(sends, [NOW + 43_200, NOW + 43_200 + 500 + 129_600]);
});

test('a restarted dispatcher waits a full gap before its first call', async () => {
  const { db, clock } = setup();
  const sends: number[] = [];
  await dispatcher(db, SMALL, clock).call(CallKind.Plain, async () => sends.push(clock.now()));

  await dispatcher(db, SMALL, clock).call(CallKind.Plain, async () => sends.push(clock.now()));

  assert.equal(sends[1] - sends[0], SMALL.spacingMs);
});

test('refuses calls beyond the daily cap, across restarts, until the next UTC day', async () => {
  const { db, clock, calls, send } = setup();
  for (let i = 0; i < 5; i++) {
    await calls.call(CallKind.Plain, send());
  }

  const restarted = dispatcher(db, SMALL, clock);
  await assert.rejects(restarted.call(CallKind.Plain, send()), (err) =>
    err instanceof RefusedError && err.until === (Math.floor(clock.now() / DAY_MS) + 1) * DAY_MS);

  clock.advance(DAY_MS);
  assert.equal(await restarted.call(CallKind.Plain, send()), 'ok');
});

test('counts re-check searches apart and refuses them beyond their daily share', async () => {
  const { db, clock, calls, send } = setup();
  await calls.call(CallKind.Recheck, send());
  await calls.call(CallKind.Recheck, send());
  assert.equal(calls.rechecksLeft(), 0);

  const restarted = dispatcher(db, SMALL, clock);
  await assert.rejects(restarted.call(CallKind.Recheck, send()), RefusedError);
  assert.equal(await restarted.call(CallKind.Plain, send()), 'ok');
  assert.equal(upstream(db).calls, 3);

  clock.advance(DAY_MS);
  assert.equal(restarted.rechecksLeft(), 2);
});

const RETRY_AFTERS = [
  ['delta seconds', '50985', 50_985_000],
  ['an HTTP date', new Date(NOW + 3000 + 120_000).toUTCString(), 120_000],
] as const;

for (const [label, header, waitMs] of RETRY_AFTERS) {
  test(`stores a 429 ban from Retry-After as ${label} and sends nothing before it ends`, async () => {
    const { db, clock, sends, calls, send } = setup();
    mock.method(console, 'error', () => {});

    await assert.rejects(calls.call(CallKind.Plain, send(new RateLimitedError('Spotify search', header))));
    const bannedUntil = NOW + 3000 + waitMs;
    assert.equal(upstream(db).banned_until, bannedUntil);

    const restarted = dispatcher(db, SMALL, clock);
    await assert.rejects(restarted.call(CallKind.Plain, send()), (err) => err instanceof RefusedError && err.until === bannedUntil);
    assert.equal(sends.length, 1);

    clock.advance(bannedUntil - clock.now());
    assert.equal(await restarted.call(CallKind.Plain, send()), 'ok');
  });
}

test('an outcome never lowers a stored ban or hold', async () => {
  const { db, calls } = setup();
  mock.method(console, 'error', () => {});
  const later = NOW + 10 * DAY_MS;

  await assert.rejects(calls.call(CallKind.Plain, async () => {
    db.prepare("UPDATE upstream SET banned_until = ?, held_until = ? WHERE service = 'spotify'").run(later, later);
    throw new RateLimitedError('Spotify search', '10');
  }));

  assert.equal(upstream(db).banned_until, later);
  assert.equal(upstream(db).held_until, later);
});

test('backs off from failures for growing times up to an hour, and resets on success', async () => {
  const { db, clock, calls, send } = setup({ ...SMALL, dailyCalls: Infinity });
  mock.method(console, 'error', () => {});
  const waits: number[] = [];
  for (let i = 0; i < 9; i++) {
    await assert.rejects(calls.call(CallKind.Plain, send(new UnavailableError('Spotify', 503))));
    const until = Number(upstream(db).banned_until);
    waits.push(until - clock.now());
    clock.advance(until - clock.now());
  }

  assert.deepEqual(waits, [30, 60, 120, 240, 480, 960, 1920, 3600, 3600].map((s) => s * 1000));
  await calls.call(CallKind.Plain, send());
  assert.equal(upstream(db).failures, 0);
});

for (const [label, error] of [
  ['401', new UnauthorizedError('Spotify search', 401)],
  ['a response without is_playable', new ResponseFormatError('Spotify search', 'a track without is_playable')],
] as const) {
  test(`holds the service after ${label} until an operator unblocks it, keeping its ban`, async () => {
    const { db, clock, calls, send } = setup();
    mock.method(console, 'error', () => {});
    db.prepare("UPDATE upstream SET banned_until = ? WHERE service = 'spotify'").run(NOW + DAY_MS);

    clock.advance(DAY_MS);
    await assert.rejects(calls.call(CallKind.Plain, send(error)));
    assert.equal(upstream(db).held_until, UNTIL_UNBLOCKED);
    db.prepare("UPDATE upstream SET banned_until = ? WHERE service = 'spotify'").run(clock.now() + DAY_MS);

    clock.advance(365 * DAY_MS);
    await assert.rejects(calls.call(CallKind.Plain, send()), RefusedError);

    admin(db, clock, 'unblock', 'spotify');
    const bannedUntil = clock.now() - 365 * DAY_MS + DAY_MS;
    assert.equal(upstream(db).banned_until, bannedUntil);
    assert.equal(await calls.call(CallKind.Plain, send()), 'ok');
  });
}

test('an operator hold applies to the next call of a running dispatcher', async () => {
  const { db, clock, calls, send } = setup();
  await calls.call(CallKind.Plain, send());

  admin(db, clock, 'hold', 'all', '--reason', 'maintenance');

  await assert.rejects(calls.call(CallKind.Plain, send()), RefusedError);
  admin(db, clock, 'unblock', 'all', '--not-before', new Date(clock.now() + 60_000).toISOString());
  await assert.rejects(calls.call(CallKind.Plain, send()), RefusedError);
  clock.advance(60_000);
  assert.equal(await calls.call(CallKind.Plain, send()), 'ok');
});

test('only clear-ban lowers a ban', async () => {
  const { db, clock, calls, send } = setup();
  db.prepare("UPDATE upstream SET banned_until = ? WHERE service = 'spotify'").run(UNTIL_UNBLOCKED);

  admin(db, clock, 'unblock', 'spotify');
  await assert.rejects(calls.call(CallKind.Plain, send()), RefusedError);

  admin(db, clock, 'clear-ban', 'spotify', '--reason', 'bad header');
  assert.equal(await calls.call(CallKind.Plain, send()), 'ok');
  assert.equal(upstream(db).ban_reason, 'cleared: bad header');
});

test('other failures neither ban nor hold the service', async () => {
  const { db, calls, send } = setup();

  await assert.rejects(calls.call(CallKind.Plain, send(new UpstreamError('Spotify search', 400))));

  assert.equal(upstream(db).banned_until, 0);
  assert.equal(upstream(db).held_until, 0);
  assert.equal(upstream(db).calls, 1);
});

test('a reservation counts even when the process dies before sending', async () => {
  const { db, calls } = setup();

  await assert.rejects(calls.call(CallKind.Plain, async () => {
    throw new Error('killed');
  }));

  assert.equal(upstream(db).calls, 1);
});
