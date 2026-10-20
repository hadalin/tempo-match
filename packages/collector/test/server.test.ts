import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';
import { identityOf, MAX_REPORT_BYTES, parseReport, SOURCE_GETSONGBPM } from '@tempo-match/catalog';
import { runCommand } from '../src/commands.ts';
import { CallKind, dispatcher } from '../src/dispatcher.ts';
import { RateLimitedError, UnauthorizedError } from '../src/errors.ts';
import { SPOTIFY } from '../src/policies.ts';
import { reports } from '../src/reports.ts';
import { collectorServer } from '../src/server.ts';
import { acceptance, awaitingOperator, ranges, Verification } from '../src/status.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock, NOW } from './fake-clock.ts';

const ID = 'A'.repeat(22);
const REPORT = { suspects: [{ market: 'US', spotifyTrackId: ID }] };
// A matcher that still counts countries may report to the collector during a redeploy.
const COUNTING_REPORT = { ...REPORT, countries: { US: { served: 3, fallback: 2, empty: 1, dead: 0 } } };

async function serve(t: { after(fn: () => void): void }, problems = (db: DatabaseSync) => awaitingOperator(db)) {
  const { db } = memoryCatalog();
  const received = reports();
  const server = collectorServer(received, () => problems(db));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (body: string) => fetch(`${base}/reports`, { method: 'POST', body });
  return { db, received, base, post };
}

test('accepts a report, keeping its suspects', async (t) => {
  const { received, post } = await serve(t);

  assert.equal((await post(JSON.stringify(REPORT))).status, 204);
  assert.deepEqual(received.suspects(), REPORT.suspects);
  assert.equal((await post(JSON.stringify({ suspects: [] }))).status, 204);
  assert.deepEqual(received.suspects(), []);
});

test('accepts a report with country counts, keeping its suspects and storing no counts', async (t) => {
  const { db, received, post } = await serve(t);

  assert.equal((await post(JSON.stringify(COUNTING_REPORT))).status, 204);

  assert.deepEqual(received.suspects(), REPORT.suspects);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'country_daily'").get(), undefined);
});

test('rejects a malformed report and one over 64 KB', async (t) => {
  const { received, post } = await serve(t);

  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ ...REPORT, suspects: [{ market: 'US', spotifyTrackId: 'short' }] }))).status, 400);
  const huge = await post(JSON.stringify({ ...REPORT, padding: 'x'.repeat(MAX_REPORT_BYTES) })).catch(() => null);
  assert.ok(huge === null || huge.status === 413);
  assert.deepEqual(received.suspects(), []);
});

test('answers health checks by the scheduler state', async (t) => {
  const { base } = await serve(t);
  const stalled = await serve(t, () => ['scheduler stalled']);

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const res = await fetch(`${stalled.base}/healthz`);
  assert.deepEqual([res.status, await res.text()], [503, 'scheduler stalled']);
  assert.equal((await fetch(`${base}/reports`)).status, 404);
});

test('fails health checks while a failure holds an upstream until an operator unblocks it', async (t) => {
  const { db, base } = await serve(t);
  const clock = fakeClock();
  const calls = dispatcher(db, SPOTIFY, clock, () => 0.5);
  const fail = (error: Error) => assert.rejects(calls.call(CallKind.Plain, async () => { throw error; }));
  const health = async () => {
    const res = await fetch(`${base}/healthz`);
    return [res.status, await res.text()];
  };
  const admin = (...args: string[]) =>
    runCommand(args, { db, path: ':memory:', market: 'US', verification: Verification.Checked, now: clock.now() });
  const logged = mock.method(console, 'error', () => {});

  assert.deepEqual(await health(), [200, 'ok']);

  await fail(new RateLimitedError('Spotify search', '3600'));
  assert.deepEqual(await health(), [200, 'ok']);
  clock.advance(3600_000);

  await fail(new UnauthorizedError('Spotify search', 401));
  assert.deepEqual(await health(), [503, 'spotify held: Spotify search request failed with HTTP 401']);
  assert.match(
    String(logged.mock.calls.at(-1)?.arguments[0]),
    /error.*Spotify search request failed with HTTP 401.*docker compose exec collector node packages\/collector\/src\/admin\.ts unblock spotify/,
  );

  admin('unblock', 'spotify');
  assert.deepEqual(await health(), [200, 'ok']);

  admin('hold', 'spotify', '--reason', 'maintenance');
  assert.deepEqual(await health(), [200, 'ok']);
  admin('unblock', 'spotify', '--not-before', new Date(clock.now() + 60_000).toISOString());
  assert.deepEqual(await health(), [200, 'ok']);
});

test('a report of 200 suspects fits in 64 KB', () => {
  const suspects = Array.from({ length: 200 }, (_, i) => ({ market: 'US', spotifyTrackId: String(i).padStart(22, 'A') }));
  const text = JSON.stringify({ suspects });

  assert.ok(text.length < MAX_REPORT_BYTES, `${text.length} bytes`);
  assert.equal(parseReport(text)?.suspects.length, 200);
  assert.equal(parseReport(JSON.stringify({ suspects: [...suspects, suspects[0]] })), null);
});

test('acceptance needs a GetSongBPM pass and 5 checked ids at every BPM 60-210', () => {
  const { db, t } = memoryCatalog();
  const insertDone = db.prepare("INSERT INTO crawl_state (source, bpm, seed, next_index, done_at) VALUES ('getsongbpm', ?, '', 0, ?)");
  assert.match(acceptance(db, 'US', NOW, Verification.Checked), /no complete GetSongBPM pass; under 5 ids at 60-210 BPM/);

  for (let bpm = 40; bpm <= 220; bpm++) {
    insertDone.run(bpm, NOW);
  }
  for (let bpm = 60; bpm <= 210; bpm++) {
    for (let i = 0; i < 5; i++) {
      const identity = identityOf(`S${bpm}-${i}`, 'A');
      t.upsertListings([{ identity, bpm, title: 'S', artist: 'A', popularity: 0.5, source: SOURCE_GETSONGBPM }], NOW);
      t.applyLookup('US', identity, `${bpm}${i}`.padStart(22, 'X'), NOW);
    }
  }
  assert.equal(acceptance(db, 'US', NOW, Verification.Unverified), 'met (unverified)');
  assert.match(acceptance(db, 'US', NOW, Verification.Checked), /under 5 ids at 60-210 BPM/);

  db.prepare('UPDATE picks SET features_at = ?').run(NOW);
  assert.equal(acceptance(db, 'US', NOW, Verification.Checked), 'met');
  db.prepare("UPDATE upstream SET held_until = ?, hold_reason = 'Spotify search request failed: response format: x' WHERE service = 'spotify'").run(NOW + 1);
  assert.match(acceptance(db, 'US', NOW, Verification.Checked), /held for its response format/);
});

test('status reports services, catalog and picks', () => {
  const { db, t } = memoryCatalog();
  const identity = identityOf('Song', 'A');
  t.upsertListings([{ identity, bpm: 120, title: 'Song', artist: 'A', popularity: 0.5, source: SOURCE_GETSONGBPM }], NOW);
  t.applyLookup('US', identity, ID, NOW);
  const out = runCommand(['status'], { db, path: ':memory:', market: 'US', verification: Verification.Checked, now: NOW });

  assert.match(out, /spotify: 0 calls today, 0 re-check searches, 0 failures/);
  assert.match(out, /1 songs at 1 BPMs/);
  assert.match(out, /1 ids at 1 BPMs/);
  assert.doesNotMatch(out, /Countries/);
});

test('names BPM ranges compactly', () => {
  assert.equal(ranges([70, 60, 61, 62, 90, 91]), '60-62, 70, 90-91');
  assert.equal(ranges([]), '');
});
