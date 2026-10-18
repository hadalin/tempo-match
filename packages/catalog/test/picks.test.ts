import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  DAY_MS,
  matcherQueries,
  MISS_LIFETIME_MS,
  openWriter,
  PICK_LIFETIME_MS,
  SOURCE_DEEZER,
  SOURCE_GETSONGBPM,
  transitions,
  UNSEEN_LISTING_MS,
  type Listing,
} from '../src/index.ts';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);
const C = 'C'.repeat(22);
const US = 'US';
const GB = 'GB';
const NOW = Date.UTC(2026, 9, 18);

function catalog() {
  const db = openWriter(':memory:');
  const t = transitions(db);
  const q = matcherQueries(db);
  const list = (identity: string, bpm: number, extra: Partial<Listing> = {}, now = NOW) =>
    t.upsertListings(
      [{ identity, bpm, title: identity, artist: 'Artist', popularity: 0.5, source: SOURCE_GETSONGBPM, ...extra }],
      now,
    );
  return { db, t, q, list };
}

function picks(db: DatabaseSync, market = US) {
  return db
    .prepare('SELECT bpm, identity, spotify_track_id AS id, tempo FROM picks WHERE market = ? ORDER BY bpm, identity')
    .all(market)
    .map((row) => ({ ...row }));
}

function misses(db: DatabaseSync, market = US) {
  return db
    .prepare('SELECT identity, reason FROM misses WHERE market = ? ORDER BY identity')
    .all(market)
    .map((row) => ({ ...row }));
}

/** No pick and no miss in the market: the fill may look the song up. */
function isCandidate(db: DatabaseSync, identity: string, market = US): boolean {
  const known = db.prepare(`
    SELECT 1 FROM picks WHERE market = :market AND identity = :identity
    UNION ALL SELECT 1 FROM misses WHERE market = :market AND identity = :identity
  `);
  return known.get({ market, identity }) === undefined;
}

test('a negative lookup removes the song at every BPM of that market only', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  list('song', 123);
  t.applyLookup(US, 'song', A, NOW);
  t.applyLookup(GB, 'song', A, NOW);

  t.applyLookup(US, 'song', null, NOW + 1);

  assert.deepEqual(picks(db), []);
  assert.deepEqual(misses(db), [{ identity: 'song', reason: 'not-found' }]);
  assert.equal(picks(db, GB).length, 2);
});

test('a same-id lookup keeps the checked features at every listing', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  list('song', 121);
  list('song', 130);
  t.applyLookup(US, 'song', A, NOW);
  t.applyFeatures(A, { tempo: 120, speechiness: 0.1 }, NOW);

  t.applyLookup(US, 'song', A, NOW + DAY_MS);

  assert.deepEqual(picks(db), [
    { bpm: 120, identity: 'song', id: A, tempo: 120 },
    { bpm: 121, identity: 'song', id: A, tempo: 120 },
  ]);
});

test('another recording replaces the old one at every listing, unchecked', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  list('song', 121);
  t.applyLookup(US, 'song', A, NOW);
  t.applyFeatures(A, { tempo: 120, speechiness: 0.1 }, NOW);

  t.applyLookup(US, 'song', B, NOW + 1);
  assert.deepEqual(picks(db), [
    { bpm: 120, identity: 'song', id: B, tempo: null },
    { bpm: 121, identity: 'song', id: B, tempo: null },
  ]);

  t.applyFeatures(B, { tempo: 124, speechiness: 0.1 }, NOW + 2);
  assert.deepEqual(picks(db), [{ bpm: 121, identity: 'song', id: B, tempo: 124 }]);
});

test('a replacement is placed at a listing the old recording did not fit', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  list('song', 130);
  t.applyLookup(US, 'song', A, NOW);
  t.applyFeatures(A, { tempo: 120, speechiness: 0.1 }, NOW);
  assert.deepEqual(picks(db).map((p) => p.bpm), [120]);

  t.applyLookup(US, 'song', B, NOW + 1);
  t.applyFeatures(B, { tempo: 130, speechiness: 0.1 }, NOW + 2);

  assert.deepEqual(picks(db), [{ bpm: 130, identity: 'song', id: B, tempo: 130 }]);
  assert.deepEqual(misses(db), []);
});

test('a new listing is served at no call when the known tempo fits it', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  t.applyLookup(US, 'song', A, NOW);
  t.applyFeatures(A, { tempo: 121, speechiness: 0.1 }, NOW);

  list('song', 123);
  list('song', 125);

  assert.deepEqual(picks(db).map((p) => p.bpm), [120, 123]);
});

test('a spoken recording leaves misses without track ids in every market', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  t.applyLookup(US, 'song', A, NOW);
  t.applyLookup(GB, 'song', A, NOW);

  t.applyFeatures(A, { tempo: 120, speechiness: 0.9 }, NOW);

  assert.deepEqual(picks(db), []);
  assert.deepEqual(picks(db, GB), []);
  assert.deepEqual(misses(db), [{ identity: 'song', reason: 'spoken' }]);
  assert.deepEqual(misses(db, GB), [{ identity: 'song', reason: 'spoken' }]);
});

test('a tempo miss goes when the crawl adds a listing at another BPM', () => {
  const { db, t, list } = catalog();
  list('song', 130);
  t.applyLookup(US, 'song', A, NOW);
  t.applyFeatures(A, { tempo: 120, speechiness: 0.1 }, NOW);
  assert.deepEqual(misses(db), [{ identity: 'song', reason: 'tempo' }]);

  list('song', 120);
  assert.ok(isCandidate(db, 'song'));

  t.applyLookup(US, 'song', A, NOW + 1);
  t.applyFeatures(A, { tempo: 120, speechiness: 0.1 }, NOW + 2);
  assert.deepEqual(picks(db).map((p) => p.bpm), [120]);
});

test('a lookup reuses the checked tempo of the recording from another song', () => {
  const { db, t, list } = catalog();
  list('owner', 120);
  list('alias', 122);
  list('other', 126);
  t.applyLookup(US, 'owner', A, NOW);
  t.applyFeatures(A, { tempo: 121, speechiness: 0.1 }, NOW);

  t.applyLookup(US, 'alias', A, NOW + 1);
  t.applyLookup(US, 'other', A, NOW + 1);

  assert.deepEqual(picks(db), [
    { bpm: 120, identity: 'owner', id: A, tempo: 121 },
    { bpm: 122, identity: 'alias', id: A, tempo: 121 },
  ]);
  assert.deepEqual(misses(db), [{ identity: 'other', reason: 'tempo' }]);
});

test('a second song resolving to a served recording gets a duplicate miss, not a row', () => {
  const { db, t, q, list } = catalog();
  for (let i = 0; i < 1000; i++) {
    list(`song ${i}`, 120);
  }

  for (let i = 0; i < 1000; i++) {
    t.applyLookup(US, `song ${i}`, A, NOW);
  }

  assert.equal(picks(db).length, 1);
  assert.equal(misses(db).filter((m) => m.reason === 'duplicate').length, 999);
  assert.equal(q.songAt(US, 120, [A], NOW, 0), null);
});

test('the schema allows one row per market, BPM and track id and never updates an id', () => {
  const { db, t, list } = catalog();
  list('a', 120);
  list('b', 120);
  t.applyLookup(US, 'a', A, NOW);
  const insert = db.prepare(`INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, shuffle)
    VALUES ('US', 120, 'b', ?, 0, 0)`);

  assert.throws(() => insert.run(A), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare('UPDATE picks SET spotify_track_id = ?').run(B), /never updated/);
});

test('the schema refuses a pick at the wrong tempo or a spoken one', () => {
  const { db, list } = catalog();
  list('a', 120);
  const insert = db.prepare(`INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, tempo, speechiness, shuffle)
    VALUES ('US', 120, 'a', ?, 0, ?, ?, 0)`);

  assert.throws(() => insert.run(A, 124, null), /CHECK constraint failed/);
  assert.throws(() => insert.run(A, null, 0.7), /CHECK constraint failed/);
});

test('a pick is not served after its lifetime and the sweep deletes it', () => {
  const { db, t, q, list } = catalog();
  list('song', 120, {}, NOW);
  t.applyLookup(US, 'song', A, NOW);
  const expired = NOW + PICK_LIFETIME_MS;
  list('song', 120, {}, expired);

  assert.equal(q.songAt(US, 120, [], expired - 1, 0)?.spotifyTrackId, A);
  assert.equal(q.songAt(US, 120, [], expired, 0), null);

  t.sweep(US, expired);
  assert.deepEqual(picks(db), []);
});

test('the sweep deletes old misses, other markets and listings no pass has seen', () => {
  const { db, t, list } = catalog();
  list('old', 120, {}, NOW);
  list('new', 120, {}, NOW + UNSEEN_LISTING_MS);
  t.applyLookup(GB, 'new', A, NOW);
  t.applyLookup(US, 'new', null, NOW);

  t.sweep(US, NOW + UNSEEN_LISTING_MS);

  assert.deepEqual(picks(db, GB), []);
  assert.deepEqual(misses(db), []);
  assert.deepEqual(db.prepare('SELECT identity FROM songs').all().map((r) => r.identity), ['new']);
  assert.ok(MISS_LIFETIME_MS < UNSEEN_LISTING_MS);
});

test('a listing that turns out too short loses its pick; a deleted listing cascades', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  list('song', 121);
  t.applyLookup(US, 'song', A, NOW);

  list('song', 120, { durationS: 60, source: SOURCE_DEEZER });
  assert.deepEqual(picks(db).map((p) => p.bpm), [121]);

  db.prepare("DELETE FROM songs WHERE identity = 'song' AND bpm = 121").run();
  assert.deepEqual(picks(db), []);
});

test('a listing keeps the longest known duration, the first ISRC and both sources', () => {
  const { db, list } = catalog();
  list('song', 120, { isrc: 'USAAA0000001', durationS: 200, source: SOURCE_DEEZER });
  list('song', 120, { isrc: 'USBBB0000002', durationS: 60, source: SOURCE_DEEZER });
  list('song', 120, { source: SOURCE_GETSONGBPM });

  assert.deepEqual({ ...db.prepare('SELECT isrc, duration_s, sources, status FROM songs').get() }, {
    isrc: 'USAAA0000001',
    duration_s: 200,
    sources: SOURCE_GETSONGBPM | SOURCE_DEEZER,
    status: 'ok',
  });
});

test('no data from ReccoBeats marks the picks checked and keeps them', () => {
  const { db, t, list } = catalog();
  list('song', 120);
  t.applyLookup(US, 'song', A, NOW);

  t.applyFeatures(A, null, NOW + 1);

  const row = db.prepare('SELECT features_at, tempo FROM picks').get();
  assert.deepEqual({ ...row }, { features_at: NOW + 1, tempo: null });
});

// Review round 5, R5.1: a duplicate miss must go when the song serving the recording leaves.
test('a duplicate miss goes when the serving song loses its listing', () => {
  const { db, t, q, list } = catalog();
  list('owner', 120);
  list('alias', 120);
  t.applyLookup(US, 'owner', A, NOW);
  t.applyLookup(US, 'alias', A, NOW + 1);
  t.applyFeatures(A, { tempo: 121, speechiness: 0.1 }, NOW + 2);
  assert.deepEqual(misses(db), [{ identity: 'alias', reason: 'duplicate' }]);

  list('owner', 120, { durationS: 60, source: SOURCE_DEEZER });

  assert.ok(isCandidate(db, 'alias'));
  t.applyLookup(US, 'alias', A, NOW + 3);
  assert.equal(q.songAt(US, 120, [], NOW + 4, 0)?.spotifyTrackId, A);
  assert.equal(picks(db).length, 1);
});

test('a duplicate miss goes when the duplicate song gains a listing', () => {
  const { db, t, q, list } = catalog();
  list('owner', 120);
  list('alias', 120);
  t.applyLookup(US, 'owner', A, NOW);
  t.applyLookup(US, 'alias', A, NOW + 1);
  t.applyFeatures(A, { tempo: 121, speechiness: 0.1 }, NOW + 2);

  list('alias', 123);

  assert.ok(isCandidate(db, 'alias'));
  t.applyLookup(US, 'alias', A, NOW + 3);
  assert.equal(q.songAt(US, 123, [], NOW + 4, 0)?.spotifyTrackId, A);
  assert.deepEqual(picks(db).map((p) => [p.bpm, p.identity]), [[120, 'owner'], [123, 'alias']]);
});

test('a duplicate miss goes when the serving pick expires', () => {
  const { db, t, list } = catalog();
  list('owner', 120);
  list('alias', 120);
  t.applyLookup(US, 'owner', A, NOW);
  t.applyLookup(US, 'alias', A, NOW + MISS_LIFETIME_MS);

  t.sweep(US, NOW + PICK_LIFETIME_MS);

  assert.ok(isCandidate(db, 'alias'));
});

test('a duplicate miss stays while another pick of that BPM goes', () => {
  const { db, t, list } = catalog();
  list('owner', 120);
  list('alias', 120);
  list('other', 121);
  t.applyLookup(US, 'owner', A, NOW);
  t.applyLookup(US, 'alias', A, NOW);
  t.applyLookup(US, 'other', B, NOW);

  t.applyLookup(US, 'other', null, NOW + 1);

  assert.deepEqual(misses(db), [
    { identity: 'alias', reason: 'duplicate' },
    { identity: 'other', reason: 'not-found' },
  ]);
});

test('only picks hold a Spotify column', () => {
  const { db } = catalog();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const spotifyColumns = tables.flatMap(({ name }) =>
    db.prepare(`PRAGMA table_info(${String(name)})`).all()
      .filter((column) => /spotify|track/i.test(String(column.name)))
      .map((column) => `${String(name)}.${String(column.name)}`),
  );

  assert.deepEqual(spotifyColumns, ['picks.spotify_track_id']);
});

test('lucky never serves the excluded BPM and wraps around the shuffle order', () => {
  const { t, q, list } = catalog();
  list('a', 120);
  list('b', 121);
  t.applyLookup(US, 'a', A, NOW);
  t.applyLookup(US, 'b', B, NOW);

  for (const random of [0, 0.5, 0.999999]) {
    assert.equal(q.lucky(US, 120, [], NOW, random)?.spotifyTrackId, B);
  }
  assert.equal(q.lucky(US, 120, [B], NOW, 0), null);
  assert.equal(q.lucky(GB, 100, [], NOW, 0), null);
});

test('songAt serves the listing title and skips up to two ids', () => {
  const { t, q, list } = catalog();
  list('a', 120, { title: 'Song A' });
  list('b', 120);
  list('c', 120);
  t.applyLookup(US, 'a', A, NOW);
  t.applyLookup(US, 'b', B, NOW);
  t.applyLookup(US, 'c', C, NOW);

  assert.deepEqual(q.songAt(US, 120, [B, C], NOW, 0.3), {
    title: 'Song A',
    artist: 'Artist',
    bpm: 120,
    spotifyTrackId: A,
  });
  assert.equal(q.isPick(US, A, NOW), true);
  assert.equal(q.isPick(GB, A, NOW), false);
  assert.deepEqual(q.summary(US, NOW), { picks: 3, oldestLookedUpAt: NOW });
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function assertInvariants(db: DatabaseSync, label: string, swept: boolean) {
  const both = db.prepare(`SELECT p.market, p.identity FROM picks p
    JOIN misses m ON m.market = p.market AND m.identity = p.identity LIMIT 1`).get();
  assert.equal(both, undefined, `${label}: a song with a pick and a miss`);

  const mixed = db.prepare(`SELECT market, identity FROM picks GROUP BY market, identity
    HAVING count(DISTINCT spotify_track_id) > 1 OR count(DISTINCT looked_up_at) > 1
      OR count(DISTINCT coalesce(tempo, -1)) > 1 OR count(DISTINCT coalesce(features_at, -1)) > 1`).get();
  assert.equal(mixed, undefined, `${label}: rows of one song disagree`);

  const orphan = db.prepare(`SELECT p.bpm FROM picks p LEFT JOIN songs s
    ON s.identity = p.identity AND s.bpm = p.bpm WHERE s.status IS NOT 'ok' LIMIT 1`).get();
  assert.equal(orphan, undefined, `${label}: a pick without an ok listing`);

  const staleDuplicate = db.prepare(`SELECT m.identity FROM misses m WHERE m.reason = 'duplicate'
    AND NOT EXISTS (SELECT 1 FROM songs s JOIN picks p ON p.market = m.market AND p.bpm = s.bpm
      WHERE s.identity = m.identity AND s.status = 'ok') LIMIT 1`).get();
  assert.equal(staleDuplicate, undefined, `${label}: a duplicate miss that nothing serves`);

  if (!swept) {
    return;
  }
  const unplaced = db.prepare(`SELECT s.identity, s.bpm FROM songs s
    JOIN (SELECT DISTINCT market, identity, spotify_track_id, tempo FROM picks) p ON p.identity = s.identity
    WHERE s.status = 'ok' AND (p.tempo IS NULL OR abs(p.tempo - s.bpm) <= 3)
      AND NOT EXISTS (SELECT 1 FROM picks q WHERE q.market = p.market AND q.bpm = s.bpm
        AND q.spotify_track_id = p.spotify_track_id) LIMIT 1`).get();
  assert.equal(unplaced, undefined, `${label}: a fitting listing without the recording`);

}

test('random transitions keep the invariants', () => {
  const identities = ['a', 'b', 'c', 'd', 'e'];
  const ids = [A, B, C];
  for (let seed = 1; seed <= 100; seed++) {
    const random = seeded(seed);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const { db, t, list } = catalog();
    let now = NOW;
    for (let step = 0; step < 200; step++) {
      now += Math.floor(random() * 10 * DAY_MS);
      const op = Math.floor(random() * 6);
      const identity = pick(identities);
      if (op === 0) {
        const short = random() < 0.2;
        list(identity, 118 + Math.floor(random() * 6), short ? { durationS: 60, source: SOURCE_DEEZER } : {}, now);
      } else if (op === 1) {
        t.applyLookup(pick([US, GB]), identity, random() < 0.2 ? null : pick(ids), now);
      } else if (op === 2) {
        const r = random();
        const features = r < 0.2 ? null : { tempo: r < 0.4 ? null : 117 + random() * 8, speechiness: r < 0.5 ? 0.9 : 0.1 };
        t.applyFeatures(pick(ids), features, now);
      } else if (op === 3) {
        t.sweep(US, now);
      } else if (op === 4) {
        db.prepare('DELETE FROM songs WHERE identity = ? AND bpm = ?').run(identity, 118 + Math.floor(random() * 6));
      } else {
        list(identity, 118 + Math.floor(random() * 6), {}, now);
      }
      assertInvariants(db, `seed ${seed} step ${step} op ${op}`, op === 3);
    }
  }
});
