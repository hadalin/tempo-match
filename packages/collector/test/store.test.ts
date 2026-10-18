import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  BusyError,
  createEngine,
  reccoBeats,
  spotify,
  type SongProvider,
  type TempoSong,
  type TempoVerifier,
  type TrackCatalog,
} from '../src/index.ts';
import { memorySongStore, openSongStore, type Resolution, type SongStore } from '../src/store.ts';
import { fakeFetch, json, type Call } from './fake-fetch.ts';

const KEEP_ORDER = () => 0.999;
const DAY_MS = 24 * 3600 * 1000;
const CREDS = { clientId: 'id', clientSecret: 's', market: 'US' };
const HOTEL = { title: 'Hotel California', artist: 'Eagles', bpm: 75 };

function source(songs: TempoSong[]): SongProvider {
  return { songsAt: async () => songs };
}

interface Upstream {
  fetch: typeof fetch;
  calls: Call[];
}

/** Spotify and ReccoBeats, faked: every search finds the Spotify listing of HOTEL. */
function upstream(
  items = [{ id: 'hotel', name: 'Hotel California - 2013 Remaster', artists: [{ name: 'Eagles' }] }],
  tempo = 74.8,
  reccoBeatsStatus = 200,
): Upstream {
  return fakeFetch((url) => {
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.hostname === 'api.spotify.com') {
      return json({ tracks: { items } });
    }
    if (url.hostname === 'api.reccobeats.com') {
      const href = `https://open.spotify.com/track/${url.searchParams.get('ids')}`;
      return json({ content: [{ href, tempo, speechiness: 0.04 }] }, reccoBeatsStatus);
    }
    return undefined;
  });
}

/** An engine as one server process builds it: fresh in-memory caches around the given store. */
function restart(store: SongStore, { fetch }: Upstream, now: () => number = Date.now) {
  const catalog = spotify(CREDS, fetch, now);
  return createEngine([source([HOTEL])], catalog, KEEP_ORDER, reccoBeats(fetch, now), store);
}

function spotifyCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.hostname.endsWith('spotify.com'));
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tempo-match-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a stored song costs no Spotify or ReccoBeats call', async () => {
  const store = memorySongStore();
  await restart(store, upstream()).matchSong(75);

  const later = upstream();
  const song = await restart(store, later).matchSong(75);

  assert.deepEqual(song, { ...HOTEL, spotifyTrackId: 'hotel' });
  assert.deepEqual(later.calls, []);
});

test('remembers songs across a restart in the database file', async (t) => {
  const path = join(tempDir(t), 'songs.db');
  const first = upstream();
  await restart(openSongStore(path), first).matchSong(75);
  assert.equal(spotifyCalls(first.calls).length, 2);

  const later = upstream();
  const song = await restart(openSongStore(path), later).matchSong(75);

  assert.equal(song.spotifyTrackId, 'hotel');
  assert.deepEqual(later.calls, []);
});

test('stores the Spotify track id but not the Spotify title', async (t) => {
  const path = join(tempDir(t), 'songs.db');
  await restart(openSongStore(path), upstream()).matchSong(75);

  const rows = new DatabaseSync(path).prepare('SELECT * FROM songs').all();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].spotify_track_id, 'hotel');
  assert.equal(rows[0].title, HOTEL.title);
  assert.doesNotMatch(JSON.stringify(rows), /Remaster/);
});

for (const [label, items, ttlDays] of [
  ['a song Spotify does not have', [], 14],
  ['a found song', undefined, 30],
] as const) {
  test(`searches Spotify again for ${label} after ${ttlDays} days`, async () => {
    let clock = 0;
    const now = () => clock;
    const store = memorySongStore(now);
    await restart(store, upstream(items ? [...items] : undefined), now)
      .matchSong(75)
      .catch(() => {});

    clock = ttlDays * DAY_MS - 1;
    const before = upstream(items ? [...items] : undefined);
    await restart(store, before, now).matchSong(75).catch(() => {});
    clock = ttlDays * DAY_MS;
    const after = upstream(items ? [...items] : undefined);
    await restart(store, after, now).matchSong(75).catch(() => {});

    assert.deepEqual(spotifyCalls(before.calls), []);
    assert.notDeepEqual(spotifyCalls(after.calls), []);
  });
}

test('expires rows in the database file too', async (t) => {
  let clock = 0;
  const now = () => clock;
  const path = join(tempDir(t), 'songs.db');
  await restart(openSongStore(path, now), upstream([]), now).matchSong(75).catch(() => {});

  clock = 14 * DAY_MS;
  const later = upstream([]);
  await restart(openSongStore(path, now), later, now).matchSong(75).catch(() => {});

  assert.equal(spotifyCalls(later.calls).length, 2);
});

test('remembers a song rejected for its tempo', async () => {
  const store = memorySongStore();
  await assert.rejects(restart(store, upstream(undefined, 150)).matchSong(75));

  const later = upstream(undefined, 150);
  await assert.rejects(restart(store, later).matchSong(75));

  assert.deepEqual(later.calls, []);
});

test('never stores a song ReccoBeats failed to check', async () => {
  const store = memorySongStore();
  const song = await restart(store, upstream(undefined, 75, 500)).matchSong(75);
  assert.equal(song.spotifyTrackId, 'hotel');

  const later = upstream();
  await restart(store, later).matchSong(75);

  assert.equal(spotifyCalls(later.calls).length, 2);
});

test('keeps songs in memory and logs once when the database cannot be opened', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const store = openSongStore(join(tempDir(t), 'missing', 'songs.db'));
  await restart(store, upstream()).matchSong(75);

  const later = upstream();
  const song = await restart(store, later).matchSong(75);

  assert.equal(song.spotifyTrackId, 'hotel');
  assert.deepEqual(later.calls, []);
  assert.equal(errors.mock.callCount(), 1);
});

const FOUND: Resolution = {
  outcome: 'found',
  title: 'T',
  artist: 'A',
  spotifyTrackId: 'id',
  tempo: 120,
  speechiness: 0.05,
  rejection: null,
};

for (const [label, open] of [
  ['memory', (now: () => number) => memorySongStore(now, 2)],
  ['database', (now: () => number) => openSongStore(':memory:', now, 2)],
] as const) {
  test(`evicts the oldest song beyond the bound in ${label}`, () => {
    let clock = 0;
    const store = open(() => clock);

    for (const identity of ['a', 'b', 'c']) {
      store.put('US', identity, { ...FOUND, spotifyTrackId: identity });
      clock++;
    }

    assert.equal(store.get('US', 'a'), undefined);
    assert.deepEqual(store.get('US', 'b'), { ...FOUND, spotifyTrackId: 'b' });
    assert.deepEqual(store.get('US', 'c'), { ...FOUND, spotifyTrackId: 'c' });
    assert.equal(store.get('SI', 'c'), undefined);
  });
}

function busyCatalog(): TrackCatalog & { lookups: number } {
  return {
    market: 'US',
    lookups: 0,
    async findTrackId() {
      this.lookups++;
      throw new BusyError('Spotify');
    },
    async searchTracks() {
      throw new BusyError('Spotify');
    },
  };
}

function knownCatalog(): TrackCatalog {
  return { market: 'US', findTrackId: async () => 'known', searchTracks: async () => [] };
}

function tempoOf(tempo: number): TempoVerifier {
  const features = { tempo, speechiness: 0.05 };
  return {
    featuresOf: async () => features,
    featuresOfAll: async (ids) => ids.map(() => features),
    popularityOf: async (ids) => ids.map(() => 80),
  };
}

test('answers from the store while Spotify is busy', async () => {
  const store = memorySongStore();
  const known = { title: 'Known', artist: 'A', bpm: 120 };
  await createEngine([source([known])], knownCatalog(), KEEP_ORDER, tempoOf(120), store).matchSong(120);
  const others = Array.from({ length: 9 }, (_, i) => ({ title: `S${i}`, artist: 'A', bpm: 120 }));
  const busy = busyCatalog();

  const song = await createEngine([source([...others, known])], busy, KEEP_ORDER, tempoOf(120), store)
    .matchSong(120);

  assert.deepEqual(song, { ...known, spotifyTrackId: 'known' });
  assert.equal(busy.lookups, 5);
});

test('reports Spotify busy when the store knows no listed song', async () => {
  const songs = [{ title: 'S', artist: 'A', bpm: 120 }];

  await assert.rejects(
    createEngine([source(songs)], busyCatalog(), KEEP_ORDER, tempoOf(120)).matchSong(120),
    BusyError,
  );
});

test('picks a lucky song from the store while Spotify is busy', async () => {
  const store = memorySongStore();
  const known = { title: 'Known', artist: 'A', bpm: 97 };
  await createEngine([source([known])], knownCatalog(), KEEP_ORDER, tempoOf(97.4), store).matchSong(97);
  const engine = createEngine([], busyCatalog(), KEEP_ORDER, tempoOf(97.4), store);

  assert.deepEqual(await engine.luckySong(), { ...known, spotifyTrackId: 'known' });
  await assert.rejects(engine.luckySong(undefined, 97), BusyError);
  await assert.rejects(engine.luckySong('SI'), BusyError);
});
