import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReport } from '@tempo-match/catalog';
import { flags, ipPrefix, reporter } from '../src/flags.ts';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);
const NOW = Date.UTC(2026, 9, 18, 12);
const HOUR_MS = 60 * 60 * 1000;

for (const [ip, prefix] of [
  ['192.0.2.33', '192.0.2'],
  ['::ffff:192.0.2.33', '192.0.2'],
  ['2001:db8:abcd:12::1', '2001:db8:abcd'],
  ['2001:0DB8:0000::', '2001:db8:0'],
  ['::1', '0:0:0'],
  ['1:2:3:4:5:6:7:8', '1:2:3'],
  ['256.0.0.1', null],
  ['1:2:3', null],
  ['1::2::3', null],
  ['fe80::1%eth0', null],
  ['', null],
] as const) {
  test(`takes the prefix of ${ip || 'an empty address'} as ${prefix}`, () => {
    assert.equal(ipPrefix(ip), prefix);
  });
}

test('a pick is a suspect once three prefixes flag it, most flagged first', () => {
  const f = flags();
  for (const prefix of ['a', 'b']) {
    f.flag(A, prefix, NOW);
  }
  for (const prefix of ['a', 'b', 'c', 'd']) {
    f.flag(B, prefix, NOW);
  }
  assert.deepEqual(f.suspects(NOW), [B]);

  f.flag(A, 'c', NOW);
  assert.deepEqual(f.suspects(NOW), [B, A]);
});

test('counts at most 10 flags per prefix and hour', () => {
  const f = flags();
  for (let i = 0; i < 10; i++) {
    f.flag(`${i}`.padStart(22, 'X'), 'busy', NOW);
  }
  f.flag(A, 'busy', NOW);
  f.flag(A, 'b', NOW);
  f.flag(A, 'c', NOW);
  assert.deepEqual(f.suspects(NOW), []);

  f.flag(A, 'busy', NOW + HOUR_MS);
  assert.deepEqual(f.suspects(NOW + HOUR_MS), [A]);
});

test('forgets flags after a day', () => {
  const f = flags();
  for (const prefix of ['a', 'b', 'c']) {
    f.flag(A, prefix, NOW);
  }

  assert.deepEqual(f.suspects(NOW + 24 * HOUR_MS), []);
});

test('keeps at most 10,000 flagged ids', () => {
  const f = flags();
  for (const prefix of ['a', 'b', 'c']) {
    f.flag(A, prefix, NOW);
  }
  for (let i = 0; i < 10_000; i++) {
    f.flag(`${i}`.padStart(22, 'X'), `p${i}`, NOW);
  }

  assert.deepEqual(f.suspects(NOW), []);
});

test('pushes the suspects as a valid report', async () => {
  const f = flags();
  for (const prefix of ['a', 'b', 'c']) {
    f.flag(A, prefix, NOW);
  }
  const bodies: string[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    assert.equal(String(url), 'http://collector:3001/reports');
    bodies.push(String(init.body));
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  const r = reporter('http://collector:3001', 'US', f, fetch, () => NOW);

  await r.push();

  assert.deepEqual(JSON.parse(bodies[0]), { suspects: [{ market: 'US', spotifyTrackId: A }] });
  assert.deepEqual(parseReport(bodies[0]), JSON.parse(bodies[0]));
});

test('never overlaps pushes and drops a failed one', async (t) => {
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const pending = Promise.withResolvers<Response>();
  const fetch = (async () => {
    calls++;
    return pending.promise;
  }) as unknown as typeof globalThis.fetch;
  const r = reporter('http://collector:3001', 'US', flags(), fetch);

  const first = r.push();
  await r.push();
  pending.reject(new TypeError('fetch failed'));
  await first;

  assert.equal(calls, 1);
});
