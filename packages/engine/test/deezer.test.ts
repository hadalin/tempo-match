import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine, deezer, UpstreamError, type TrackCatalog } from '../src/index.ts';
import { fakeFetch, json, type Call, type Route } from './fake-fetch.ts';

const FIRST_SEEDS = () => 0;
const POPULAR = 500_000;
const ISRC = 'USWB10400046';

function row(title: string, extra: Record<string, unknown> = {}) {
  return { title, isrc: ISRC, rank: POPULAR, artist: { name: 'A' }, ...extra };
}

function unseededOnly(data: unknown[]): Route {
  return (url) => json({ data: url.searchParams.get('q')!.startsWith('bpm_min') ? data : [] });
}

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => row(`S${i}`));
}

function queries(calls: Call[]): (string | null)[] {
  return calls.map((c) => c.url.searchParams.get('q'));
}

test('queries one BPM with quoted filters, a seed, a page size and an index', async () => {
  const { fetch, calls } = fakeFetch(() => json({ data: rows(60) }));

  await deezer(fetch, Date.now, () => 0.5).songsAt(120);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.deezer.com/search/track');
  const seededQuery = /^(track|album|label):"[^"]+" bpm_min:"120" bpm_max:"120"$/;
  assert.match(url.searchParams.get('q')!, seededQuery);
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('index'), '50');
  assert.ok(init?.signal instanceof AbortSignal);
});

test('floors the requested BPM and reports songs at it', async () => {
  const { fetch, calls } = fakeFetch(unseededOnly([row('Dreams')]));

  const songs = await deezer(fetch, Date.now, FIRST_SEEDS).songsAt(120.7);

  assert.equal(queries(calls)[0], 'bpm_min:"120" bpm_max:"120"');
  assert.deepEqual(songs, [{ title: 'Dreams', artist: 'A', bpm: 120, isrc: ISRC }]);
});

test('keeps only rows whose floored tempo is the requested BPM', async () => {
  const { fetch } = fakeFetch(
    unseededOnly([row('Kept', { bpm: 120.9 }), row('Faster', { bpm: 121.2 })]),
  );

  const songs = await deezer(fetch, Date.now, FIRST_SEEDS).songsAt(120);

  assert.deepEqual(songs.map((s) => s.title), ['Kept']);
});

test('drops incomplete and obscure tracks and omits a missing ISRC', async () => {
  const { fetch } = fakeFetch(
    unseededOnly([
      row('Hit', { isrc: undefined }),
      row('Obscure', { rank: 873 }),
      row('No Artist', { artist: undefined }),
    ]),
  );

  const songs = await deezer(fetch, Date.now, FIRST_SEEDS).songsAt(120);

  assert.deepEqual(songs, [{ title: 'Hit', artist: 'A', bpm: 120 }]);
});

for (const bpm of [40, 59, 211, 220]) {
  test(`skips BPM ${bpm}, outside Deezer's coverage, without a request`, async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: rows(60) }));

    assert.deepEqual(await deezer(fetch).songsAt(bpm), []);
    assert.equal(calls.length, 0);
  });
}

for (const bpm of [60, 210]) {
  test(`queries BPM ${bpm}, at the edge of Deezer's coverage`, async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: rows(60) }));

    await deezer(fetch).songsAt(bpm);

    assert.equal(calls.length, 1);
  });
}

test('tries up to three distinct seeds while slices are small', async () => {
  const { fetch, calls } = fakeFetch(() => json({ data: rows(5) }));

  await deezer(fetch, Date.now, FIRST_SEEDS).songsAt(120);

  assert.deepEqual(queries(calls), [
    'bpm_min:"120" bpm_max:"120"',
    'track:"a" bpm_min:"120" bpm_max:"120"',
    'track:"e" bpm_min:"120" bpm_max:"120"',
  ]);
});

test('rereads the last page when the random index is past a small slice', async () => {
  const total = 13;
  const { fetch, calls } = fakeFetch((url) => {
    const index = Number(url.searchParams.get('index'));
    return json({ data: index < total ? rows(total - index) : [], total });
  });

  const songs = await deezer(fetch, Date.now, () => 0.5).songsAt(64);

  assert.deepEqual(calls.map((c) => c.url.searchParams.get('index')), ['50', '0', '0']);
  assert.equal(songs.length, 2 * total);
});

test('reads the first page with the last request so a small slice is not missed', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    const small = url.searchParams.get('q')!.startsWith('track:"e"');
    const index = Number(url.searchParams.get('index'));
    return json(small ? { data: index === 0 ? rows(1) : [], total: 1 } : { data: [], total: 0 });
  });
  let pick = 0.5;
  const seedThenPage = () => (pick = pick === 0 ? 0.5 : 0);

  const songs = await deezer(fetch, Date.now, seedThenPage).songsAt(120);

  assert.deepEqual(calls.map((c) => c.url.searchParams.get('index')), ['50', '50', '0']);
  assert.equal(songs.length, 1);
});

test('reuses cached slices for free and spends requests on new seeds', async () => {
  const { fetch, calls } = fakeFetch(() => json({ data: rows(5) }));
  const tempo = deezer(fetch, Date.now, FIRST_SEEDS);

  await tempo.songsAt(120);
  calls.length = 0;
  const songs = await tempo.songsAt(120);

  assert.equal(songs.length, 30);
  assert.deepEqual(queries(calls), [
    'track:"o" bpm_min:"120" bpm_max:"120"',
    'track:"i" bpm_min:"120" bpm_max:"120"',
    'track:"love" bpm_min:"120" bpm_max:"120"',
  ]);
});

test('caches each BPM and seed until the cache entry expires', async () => {
  const { fetch, calls } = fakeFetch(() => json({ data: rows(60) }));
  let clock = 0;
  let pick = 0;
  const tempo = deezer(fetch, () => clock, () => pick);

  await tempo.songsAt(120);
  await tempo.songsAt(120);
  await tempo.songsAt(121);
  pick = 0.99;
  await tempo.songsAt(120);
  pick = 0;
  clock = 25 * 3600 * 1000;
  await tempo.songsAt(120);

  assert.deepEqual(queries(calls), [
    'bpm_min:"120" bpm_max:"120"',
    'bpm_min:"121" bpm_max:"121"',
    'label:"records" bpm_min:"120" bpm_max:"120"',
    'bpm_min:"120" bpm_max:"120"',
  ]);
});

test('throws UpstreamError on HTTP failure and retries the next time', async () => {
  let status = 503;
  const { fetch, calls } = fakeFetch(() => json({ data: rows(60) }, status));
  const tempo = deezer(fetch, Date.now, FIRST_SEEDS);

  await assert.rejects(tempo.songsAt(120), UpstreamError);
  status = 200;
  await tempo.songsAt(120);

  assert.equal(calls.length, 2);
});

test('throws UpstreamError on an error payload', async () => {
  const { fetch } = fakeFetch(() => json({ error: { type: 'Exception', code: 4 } }));

  await assert.rejects(deezer(fetch).songsAt(120), UpstreamError);
});

test('a Deezer failure does not fail the request', async () => {
  const { fetch } = fakeFetch(() => json({}, 503));
  const other = { songsAt: async () => [{ title: 'Found', artist: 'A', bpm: 120 }] };
  const catalog: TrackCatalog = { findTrackId: async () => 'f', searchTracks: async () => [] };

  const song = await createEngine([deezer(fetch), other], catalog).matchSong(120);

  assert.equal(song.spotifyTrackId, 'f');
});
