import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  DAY_MS,
  identityOf,
  REFRESH_AFTER_MS,
  SOURCE_GETSONGBPM,
  utcDay,
  type Suspect,
} from '@tempo-match/catalog';
import { CallKind, dispatcher } from '../src/dispatcher.ts';
import { RefusedError, UpstreamError } from '../src/errors.ts';
import { SPOTIFY } from '../src/policies.ts';
import { featureChecks, Job, spotifyJobs } from '../src/scheduler.ts';
import type { LookupSong } from '../src/spotify.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock, NOW } from './fake-clock.ts';

const ID = (letter: string) => letter.repeat(22);

function setup(found: Record<string, string | null | Error> = {}) {
  const { db, t } = memoryCatalog();
  const clock = fakeClock();
  const lookups: [string, CallKind][] = [];
  const songs: LookupSong[] = [];
  let suspects: Suspect[] = [];
  const spotify = {
    async lookup(song: LookupSong, _market: string, kind: CallKind) {
      lookups.push([song.title, kind]);
      songs.push(song);
      const answer = found[song.title] ?? null;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
  const calls = dispatcher(db, SPOTIFY, clock);
  const jobs = spotifyJobs(db, { market: 'US', transitions: t, spotify, calls, clock, suspects: () => suspects, random: () => 0 });
  const list = (title: string, bpm: number, popularity = 0.5, isrc?: string) =>
    t.upsertListings([{ identity: identityOf(title, 'A'), bpm, title, artist: 'A', popularity, source: SOURCE_GETSONGBPM, ...(isrc && { isrc }) }], clock.now());
  mock.method(console, 'log', () => {});
  return { db, t, clock, jobs, lookups, songs, list, setSuspects: (s: Suspect[]) => { suspects = s; } };
}

test('fills the BPM with the fewest picks first, ties nearest 120, most popular song first', async () => {
  const { jobs, lookups, list } = setup({ Quiet: ID('A'), Popular: ID('B') });
  list('Far', 150);
  list('Quiet', 118, 0.1);
  list('Popular', 121, 0.9);
  list('Less popular', 121, 0.2);

  assert.equal(await jobs.step(), Job.Fill);
  assert.equal(await jobs.step(), Job.Fill);
  assert.equal(await jobs.step(), Job.Fill);

  assert.deepEqual(lookups.map(([title]) => title), ['Popular', 'Quiet', 'Far']);
});

test('fill keeps looking up songs at a BPM that already has picks, until none is left', async () => {
  const { jobs, lookups, list } = setup({ One: ID('A'), Two: ID('B') });
  list('One', 120);
  list('Two', 120);

  assert.equal(await jobs.step(), Job.Fill);
  assert.equal(await jobs.step(), Job.Fill);
  assert.equal(await jobs.step(), null);
  assert.equal(lookups.length, 2);
});

test('refreshes the oldest pick shortly before it expires, before filling', async () => {
  const { db, clock, jobs, lookups, list } = setup({ Old: ID('A'), New: ID('B') });
  list('Old', 120);
  await jobs.step();
  list('New', 121);

  clock.advance(REFRESH_AFTER_MS);
  list('Old', 120);
  list('New', 121);
  assert.equal(await jobs.step(), Job.Refresh);
  assert.deepEqual(lookups.map(([title]) => title), ['Old', 'Old']);
  assert.equal(db.prepare('SELECT looked_up_at FROM picks').get()?.looked_up_at, clock.now());
  assert.equal(await jobs.step(), Job.Fill);
});

test('re-checks a suspect before anything else, once its pick is a day old', async () => {
  const { db, clock, jobs, lookups, list, setSuspects } = setup({ Dead: ID('A'), Other: ID('B') });
  list('Dead', 120);
  await jobs.step();
  list('Other', 121);
  setSuspects([{ market: 'US', spotifyTrackId: ID('A') }]);

  assert.equal(await jobs.step(), Job.Fill);
  clock.advance(DAY_MS);
  assert.equal(await jobs.step(), Job.Recheck);
  assert.deepEqual(lookups.at(-1), ['Dead', CallKind.Recheck]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM picks').get()?.n, 2);
});

test('a re-check that finds nothing playable removes the pick and stores a miss', async () => {
  const found: Record<string, string | null> = { Dead: ID('A') };
  const { db, clock, jobs, list, setSuspects } = setup(found);
  list('Dead', 120);
  await jobs.step();
  setSuspects([{ market: 'US', spotifyTrackId: ID('A') }]);
  clock.advance(DAY_MS);
  found.Dead = null;

  assert.equal(await jobs.step(), Job.Recheck);

  assert.equal(db.prepare('SELECT count(*) AS n FROM picks').get()?.n, 0);
  assert.equal(db.prepare('SELECT reason FROM misses').get()?.reason, 'not-found');
});

test('ignores suspects of other markets and waits when under two re-check searches are left', async () => {
  const { db, clock, jobs, lookups, list, setSuspects } = setup({ Dead: ID('A') });
  list('Dead', 120);
  await jobs.step();
  clock.advance(DAY_MS);
  setSuspects([{ market: 'GB', spotifyTrackId: ID('A') }]);
  assert.equal(await jobs.step(), null);

  setSuspects([{ market: 'US', spotifyTrackId: ID('A') }]);
  db.prepare("UPDATE upstream SET day = ?, recheck_calls = 99 WHERE service = 'spotify'").run(utcDay(clock.now()));
  assert.equal(await jobs.step(), null);
  assert.equal(lookups.length, 1);
});

test('a lookup refused by the dispatcher stores nothing and is tried again', async () => {
  const refused = new RefusedError('Spotify', NOW + 1000, 'banned');
  const { db, jobs, list } = setup({ Song: refused });
  list('Song', 120);

  await assert.rejects(jobs.step(), RefusedError);

  assert.equal(db.prepare('SELECT count(*) AS n FROM misses').get()?.n, 0);
});

test('a lookup that would fail the same way again is stored as not found', async () => {
  const { db, jobs, list } = setup({ Song: new UpstreamError('Spotify search', 400) });
  mock.method(console, 'error', () => {});
  list('Song', 120);

  assert.equal(await jobs.step(), Job.Fill);

  assert.equal(db.prepare('SELECT reason FROM misses').get()?.reason, 'not-found');
});

test('passes the ISRC of the most popular listing that has one', async () => {
  const { jobs, songs, list } = setup();
  list('Song', 120, 0.9);
  list('Song', 121, 0.2, 'USAAA0000001');
  list('Song', 122, 0.5, 'USBBB0000002');

  await jobs.step();

  assert.deepEqual(songs, [{ title: 'Song', artist: 'A', isrc: 'USBBB0000002' }]);
});

test('checks unchecked picks with ReccoBeats in batches and applies the features', async () => {
  const { db, t, clock, list } = setup();
  list('Song', 120);
  list('Song', 130);
  t.applyLookup('US', identityOf('Song', 'A'), ID('A'), clock.now());
  const asked: string[][] = [];
  const features = {
    featuresOf: async (ids: string[]) => {
      asked.push(ids);
      return new Map([[ID('A'), { tempo: 129, speechiness: 0.1 }]]);
    },
  };
  const checks = featureChecks(db, t, features, clock);

  assert.equal(await checks.step(), true);
  assert.equal(await checks.step(), false);

  assert.deepEqual(asked, [[ID('A')]]);
  assert.deepEqual(db.prepare('SELECT bpm, tempo FROM picks').all().map((r) => ({ ...r })), [{ bpm: 130, tempo: 129 }]);
});
