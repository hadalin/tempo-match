import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { json } from './fake-fetch.ts';
import {
  createEngine,
  engineFromEnv,
  LuckyDisabledError,
  NoLuckyPickError,
  type CatalogTrack,
  type TempoVerifier,
  type TrackCatalog,
} from '../src/index.ts';

const KEEP_ORDER = () => 0.999;
const POPULAR = 80;

interface Search {
  term: string;
  offset: number;
  market: string | undefined;
}

function track(id: string): CatalogTrack {
  return { spotifyTrackId: id, title: `Title ${id}`, artist: `Artist ${id}` };
}

function catalog(pages: CatalogTrack[][]): TrackCatalog & { searches: Search[] } {
  const searches: Search[] = [];
  return {
    searches,
    findTrackId: async () => null,
    async searchTracks(term, offset, market) {
      searches.push({ term, offset, market });
      return pages[searches.length - 1] ?? [];
    },
  };
}

function verifier(
  tempos: Record<string, number>,
  popularity: Record<string, number | null> = {},
  speechiness: Record<string, number> = {},
): TempoVerifier & { tempoLookups: string[][] } {
  const tempoLookups: string[][] = [];
  const featuresOfAll = async (ids: string[]) => {
    tempoLookups.push(ids);
    return ids.map((id) => ({ tempo: tempos[id] ?? null, speechiness: speechiness[id] ?? null }));
  };
  return {
    tempoLookups,
    featuresOf: async (id) => (await featuresOfAll([id]))[0],
    featuresOfAll,
    popularityOf: async (ids) => ids.map((id) => (id in popularity ? popularity[id] : POPULAR)),
  };
}

test('returns a popular track with its tempo rounded to a whole BPM', async () => {
  const spotify = catalog([[track('a')]]);

  const song = await createEngine([], spotify, KEEP_ORDER, verifier({ a: 97.4 })).luckySong('SI');

  assert.deepEqual(song, { title: 'Title a', artist: 'Artist a', bpm: 97, spotifyTrackId: 'a' });
  assert.equal(spotify.searches.length, 1);
  assert.equal(spotify.searches[0].market, 'SI');
});

test('searches a random seed term at a random offset', async () => {
  const low = catalog([[track('a')]]);
  const high = catalog([[track('a')]]);

  await createEngine([], low, () => 0, verifier({ a: 100 })).luckySong();
  await createEngine([], high, KEEP_ORDER, verifier({ a: 100 })).luckySong();

  assert.equal(low.searches[0].offset, 0);
  assert.equal(high.searches[0].offset, 200);
  assert.notEqual(low.searches[0].term, high.searches[0].term);
});

test('searches whole pages of ten rows within the first 200', async () => {
  const offsets: number[] = [];
  for (const random of [0, 0.04, 0.33, 0.5, 0.97, 0.999]) {
    const spotify = catalog([[track('a')]]);
    await createEngine([], spotify, () => random, verifier({ a: 100 })).luckySong();
    offsets.push(spotify.searches[0].offset);
  }

  assert.deepEqual(offsets, [0, 0, 60, 100, 200, 200]);
});

test('skips tracks with no tempo or a tempo outside 40-220 BPM', async () => {
  const page = ['none', 'slow', 'fast', 'edge'].map(track);
  const tempos = { slow: 39.4, fast: 220.6, edge: 219.6 };

  const song = await createEngine([], catalog([page]), KEEP_ORDER, verifier(tempos)).luckySong();

  assert.equal(song.spotifyTrackId, 'edge');
  assert.equal(song.bpm, 220);
});

test('skips tracks below the popularity floor without asking for their tempo', async () => {
  const page = ['niche', 'unknown', 'hit'].map(track);
  const tempos = verifier({ niche: 100, unknown: 100, hit: 100 }, { niche: 49, unknown: null });

  const song = await createEngine([], catalog([page]), KEEP_ORDER, tempos).luckySong();

  assert.equal(song.spotifyTrackId, 'hit');
  assert.deepEqual(tempos.tempoLookups, [['hit']]);
});

test('skips spoken-word tracks', async () => {
  const page = ['reading', 'song'].map(track);
  const tempos = verifier({ reading: 104, song: 104 }, {}, { reading: 0.66, song: 0.05 });

  const song = await createEngine([], catalog([page]), KEEP_ORDER, tempos).luckySong();

  assert.equal(song.spotifyTrackId, 'song');
});

test('skips a track at the excluded BPM', async () => {
  const page = ['same', 'other'].map(track);
  const tempos = verifier({ same: 120.4, other: 121 });

  const song = await createEngine([], catalog([page]), KEEP_ORDER, tempos).luckySong(undefined, 120);

  assert.equal(song.spotifyTrackId, 'other');
});

test('gives up when every track is at the excluded BPM', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => [track(`same${i}`)]);
  const tempos = verifier(Object.fromEntries(pages.map(([t]) => [t.spotifyTrackId, 120])));
  const spotify = catalog(pages);

  await assert.rejects(
    createEngine([], spotify, KEEP_ORDER, tempos).luckySong(undefined, 120),
    NoLuckyPickError,
  );

  assert.equal(spotify.searches.length, 3);
});

test('searches again when a page has no usable track', async () => {
  const spotify = catalog([[track('none')], [], [track('a')]]);

  const song = await createEngine([], spotify, KEEP_ORDER, verifier({ a: 128 })).luckySong();

  assert.equal(song.spotifyTrackId, 'a');
  assert.equal(spotify.searches.length, 3);
});

test('gives up after a bounded number of searches', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => [track(`none${i}`)]);
  const spotify = catalog(pages);
  const tempos = verifier({});

  await assert.rejects(
    createEngine([], spotify, KEEP_ORDER, tempos).luckySong(),
    NoLuckyPickError,
  );

  assert.equal(spotify.searches.length, 3);
  assert.equal(tempos.tempoLookups.length, 3);
});

test('refuses a lucky pick without a tempo source', async () => {
  const spotify = catalog([[track('a')]]);

  await assert.rejects(createEngine([], spotify, KEEP_ORDER).luckySong(), LuckyDisabledError);

  assert.deepEqual(spotify.searches, []);
});

const ENV = {
  GETSONGBPM_API_KEY: 'k',
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 's',
  SPOTIFY_MARKET: 'DE',
};
const SPOTIFY_ID = '3JvKfv6T31zO0ini8iNItO';

function liveLike(t: TestContext): URL[] {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.hostname === 'api.spotify.com') {
      const item = { id: SPOTIFY_ID, name: 'Another Love', artists: [{ name: 'Tom Odell' }] };
      return json({ tracks: { items: [item] } });
    }
    const href = `https://open.spotify.com/track/${SPOTIFY_ID}`;
    return json({ content: [{ href, popularity: 85, tempo: 122.769 }] });
  });
  return requests;
}

test('engineFromEnv picks a lucky track from Spotify with its ReccoBeats tempo', async (t) => {
  const requests = liveLike(t);

  const song = await engineFromEnv(ENV).luckySong();

  assert.deepEqual(song, {
    title: 'Another Love',
    artist: 'Tom Odell',
    bpm: 123,
    spotifyTrackId: SPOTIFY_ID,
  });
  const search = requests.find((url) => url.pathname === '/v1/search')!;
  assert.equal(search.searchParams.get('limit'), '10');
  assert.equal(search.searchParams.get('market'), 'DE');
  assert.deepEqual(
    requests.filter((url) => url.hostname === 'api.reccobeats.com').map((url) => url.pathname),
    ['/v1/track', '/v1/audio-features'],
  );
});

test('engineFromEnv refuses a lucky pick when RECCOBEATS_ENABLED is false', async (t) => {
  const requests = liveLike(t);

  await assert.rejects(
    engineFromEnv({ ...ENV, RECCOBEATS_ENABLED: 'false' }).luckySong(),
    LuckyDisabledError,
  );

  assert.deepEqual(requests, []);
});
