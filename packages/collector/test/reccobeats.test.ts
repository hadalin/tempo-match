import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEngine,
  NoMatchError,
  reccoBeats,
  UpstreamError,
  type CatalogTrack,
  type SongProvider,
  type TempoVerifier,
  type TrackCatalog,
} from '../src/index.ts';
import { fakeFetch, json, type Route } from './fake-fetch.ts';

const TRACK_ID = '6RobUVd8TmkhGHgSaIIJ7s';
const KEEP_ORDER = () => 0.999;
const SECOND_MS = 1000;
const BACK_OFF_MS = 30 * SECOND_MS;
const MAX_BACK_OFF_MS = 120 * SECOND_MS;

function features(spotifyTrackId: string, tempo: number, speechiness?: number) {
  return {
    id: '10a12344-9b40-461c-89f8-3d450d883bb8',
    href: `https://open.spotify.com/track/${spotifyTrackId}`,
    isrc: 'QZHNC2052262',
    energy: 0.755,
    tempo,
    speechiness,
  };
}

async function tempoOf(verifier: TempoVerifier, spotifyTrackId: string) {
  return (await verifier.featuresOf(spotifyTrackId)).tempo;
}

async function temposOf(verifier: TempoVerifier, spotifyTrackIds: string[]) {
  return (await verifier.featuresOfAll(spotifyTrackIds)).map((f) => f.tempo);
}

function tempos(byId: Record<string, number>): Route {
  return (url) => {
    const ids = url.searchParams.get('ids')!.split(',');
    return json({ content: ids.filter((id) => id in byId).map((id) => features(id, byId[id])) });
  };
}

function songsAt(bpm: number, count = 1): SongProvider {
  return {
    async songsAt() {
      return Array.from({ length: count }, (_, i) => ({ title: `S${i}`, artist: 'A', bpm }));
    },
  };
}

function catalog(): TrackCatalog & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    market: 'US',
    lookups,
    async findTrackId({ title }) {
      lookups.push(title);
      return title === 'S0' ? TRACK_ID : `${title}-id`;
    },
    searchTracks: async () => [],
  };
}

async function match(bpm: number, route: Route) {
  const { fetch } = fakeFetch(route);
  return createEngine([songsAt(bpm)], catalog(), KEEP_ORDER, reccoBeats(fetch)).matchSong(bpm);
}

test('requests audio features for the Spotify track id with a timeout', async () => {
  const { fetch, calls } = fakeFetch(tempos({ [TRACK_ID]: 105.058 }));

  assert.equal(await tempoOf(reccoBeats(fetch), TRACK_ID), 105.058);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.origin + calls[0].url.pathname,
    'https://api.reccobeats.com/v1/audio-features',
  );
  assert.equal(calls[0].url.searchParams.get('ids'), TRACK_ID);
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test('reports speechiness from the same audio features request', async () => {
  const { fetch, calls } = fakeFetch(() =>
    json({ content: [features(TRACK_ID, 103.7, 0.558), features('no-speech', 120)] }),
  );

  assert.deepEqual(await reccoBeats(fetch).featuresOfAll([TRACK_ID, 'no-speech', 'none']), [
    { tempo: 103.7, speechiness: 0.558 },
    { tempo: 120, speechiness: null },
    { tempo: null, speechiness: null },
  ]);
  assert.equal(calls.length, 1);
});

test('ignores rows for other tracks', async () => {
  const { fetch } = fakeFetch(() => json({ content: [features('other', 120)] }));

  assert.equal(await tempoOf(reccoBeats(fetch), TRACK_ID), null);
});

for (const tempo of [102.1, 105.058, 107.9]) {
  test(`accepts a track verified at ${tempo} BPM for a 105 BPM request`, async () => {
    const song = await match(105, tempos({ [TRACK_ID]: tempo }));

    assert.equal(song.spotifyTrackId, TRACK_ID);
  });
}

for (const [label, bpm] of [
  ['double', 210],
  ['half', 52],
] as const) {
  test(`skips a track whose verified tempo is ${label} the requested BPM`, async () => {
    await assert.rejects(match(bpm, tempos({ [TRACK_ID]: 105.058 })), NoMatchError);
  });
}

test('skips a spoken-word track and tries the next candidate', async () => {
  const { fetch } = fakeFetch(() =>
    json({ content: [features(TRACK_ID, 105, 0.66), features('S1-id', 105, 0.65)] }),
  );
  const spotify = catalog();

  const song = await createEngine([songsAt(105, 2)], spotify, KEEP_ORDER, reccoBeats(fetch))
    .matchSong(105);

  assert.equal(song.spotifyTrackId, 'S1-id');
  assert.deepEqual(spotify.lookups, ['S0', 'S1']);
});

test('tries the next candidate after a rejected one', async () => {
  const { fetch } = fakeFetch(tempos({ [TRACK_ID]: 105.058, 'S1-id': 209.6 }));
  const spotify = catalog();

  const song = await createEngine([songsAt(210, 2)], spotify, KEEP_ORDER, reccoBeats(fetch))
    .matchSong(210);

  assert.equal(song.spotifyTrackId, 'S1-id');
  assert.deepEqual(spotify.lookups, ['S0', 'S1']);
});

const UNVERIFIABLE: [string, Route][] = [
  ['has no data', tempos({})],
  ['reports a zero tempo', tempos({ [TRACK_ID]: 0 })],
  ['fails', () => json({ error: 'boom' }, 500)],
  ['is rate-limited', () => new Response(null, { status: 429, headers: { 'Retry-After': '30' } })],
  [
    'times out',
    () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  ],
  ['returns malformed JSON', () => new Response('<html>', { status: 200 })],
];

for (const [label, route] of UNVERIFIABLE) {
  test(`accepts the track when ReccoBeats ${label}`, async () => {
    const song = await match(210, route);

    assert.equal(song.spotifyTrackId, TRACK_ID);
  });
}

test('caches tempos and missing data per track until the entry expires', async () => {
  const { fetch, calls } = fakeFetch(tempos({ [TRACK_ID]: 105.058 }));
  let clock = 0;
  const verifier = reccoBeats(fetch, () => clock);

  await Promise.all([tempoOf(verifier, TRACK_ID), tempoOf(verifier, TRACK_ID)]);
  assert.equal(await tempoOf(verifier, 'unknown'), null);
  await tempoOf(verifier, 'unknown');
  await tempoOf(verifier, TRACK_ID);
  clock = 31 * 24 * 3600 * 1000;
  await tempoOf(verifier, TRACK_ID);

  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get('ids')),
    [TRACK_ID, 'unknown', TRACK_ID],
  );
});

test('retries after a failed request once the back-off ends', async () => {
  let status = 429;
  const { fetch, calls } = fakeFetch(() => json({ content: [features(TRACK_ID, 105)] }, status));
  let clock = 0;
  const verifier = reccoBeats(fetch, () => clock);

  await assert.rejects(tempoOf(verifier, TRACK_ID));
  status = 200;
  clock = BACK_OFF_MS;
  assert.equal(await tempoOf(verifier, TRACK_ID), 105);

  assert.equal(calls.length, 2);
});

test('counts rejected tracks toward the candidate bound', async () => {
  const { fetch, calls } = fakeFetch((url) =>
    json({ content: [features(url.searchParams.get('ids')!, 60)] }),
  );
  const spotify = catalog();

  await assert.rejects(
    createEngine([songsAt(120, 20)], spotify, KEEP_ORDER, reccoBeats(fetch)).matchSong(120),
    NoMatchError,
  );

  assert.equal(spotify.lookups.length, 5);
  assert.equal(calls.length, 5);
});

test('looks up tempos of uncached tracks in one request', async () => {
  const { fetch, calls } = fakeFetch(tempos({ a: 90, b: 100 }));
  const verifier = reccoBeats(fetch);

  await tempoOf(verifier, 'a');
  assert.deepEqual(await temposOf(verifier, ['a', 'b', 'c', 'b']), [90, 100, null, 100]);

  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get('ids')),
    ['a', 'b,c'],
  );
});

test('looks up Spotify popularity of tracks with a timeout', async () => {
  const { fetch, calls } = fakeFetch(() =>
    json({
      content: [
        { href: 'https://open.spotify.com/track/b', popularity: 0 },
        { href: 'https://open.spotify.com/track/a', popularity: 85 },
      ],
    }),
  );
  const verifier = reccoBeats(fetch);

  assert.deepEqual(await verifier.popularityOf(['a', 'b', 'c']), [85, 0, null]);
  await verifier.popularityOf(['a', 'c']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.reccobeats.com/v1/track');
  assert.equal(calls[0].url.searchParams.get('ids'), 'a,b,c');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test('retries a batch after it fails once the back-off ends', async () => {
  let status = 503;
  const { fetch, calls } = fakeFetch(() => json({ content: [features('a', 90)] }, status));
  let clock = 0;
  const verifier = reccoBeats(fetch, () => clock);

  await assert.rejects(temposOf(verifier, ['a', 'b']));
  status = 200;
  clock = BACK_OFF_MS;
  assert.deepEqual(await temposOf(verifier, ['a', 'b']), [90, null]);

  assert.equal(calls.length, 2);
});

function failingOnce(failure: Route): { fetch: typeof fetch; calls: { url: URL }[] } {
  let failed = false;
  return fakeFetch((url, init) => {
    if (failed) {
      return tempos({ [TRACK_ID]: 105 })(url, init);
    }
    failed = true;
    return failure(url, init);
  });
}

function rateLimited(retryAfter: string): Route {
  return () => new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } });
}

const FAILED_REQUESTS: [string, Route][] = [
  ['an HTTP error', () => json({ error: 'boom' }, 503)],
  ['a 429 without Retry-After', () => new Response(null, { status: 429 })],
  [
    'a timeout',
    () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  ],
  [
    'a network error',
    () => {
      throw new TypeError('fetch failed');
    },
  ],
];

for (const [label, failure] of FAILED_REQUESTS) {
  test(`backs off for 30 seconds after ${label}`, async () => {
    const { fetch, calls } = failingOnce(failure);
    let clock = 0;
    const verifier = reccoBeats(fetch, () => clock);

    await assert.rejects(tempoOf(verifier, TRACK_ID), UpstreamError);
    clock = BACK_OFF_MS - 1;
    await assert.rejects(tempoOf(verifier, TRACK_ID), UpstreamError);
    await assert.rejects(verifier.popularityOf(['other']), UpstreamError);
    assert.equal(calls.length, 1);

    clock = BACK_OFF_MS;
    assert.equal(await tempoOf(verifier, TRACK_ID), 105);
    assert.equal(calls.length, 2);
  });
}

for (const [retryAfter, label, waitMs] of [
  ['60', 'seconds', 60 * SECOND_MS],
  [new Date(90 * SECOND_MS).toUTCString(), 'an HTTP date', 90 * SECOND_MS],
  ['86400', 'seconds beyond two minutes', MAX_BACK_OFF_MS],
  ['0', 'zero seconds', 0],
] as const) {
  test(`backs off for a Retry-After of ${label}`, async () => {
    const { fetch, calls } = failingOnce(rateLimited(retryAfter));
    let clock = 0;
    const verifier = reccoBeats(fetch, () => clock);

    await assert.rejects(tempoOf(verifier, TRACK_ID), UpstreamError);
    if (waitMs > 0) {
      clock = waitMs - 1;
      await assert.rejects(tempoOf(verifier, TRACK_ID), UpstreamError);
    }

    clock = waitMs;
    assert.equal(await tempoOf(verifier, TRACK_ID), 105);
    assert.equal(calls.length, 2);
  });
}

test('keeps matching songs without ReccoBeats while backing off', async () => {
  const { fetch, calls } = fakeFetch(rateLimited('60'));
  const engine = createEngine([songsAt(120)], catalog(), KEEP_ORDER, reccoBeats(fetch, () => 0));

  assert.equal((await engine.matchSong(120)).spotifyTrackId, TRACK_ID);
  assert.equal((await engine.matchSong(120)).spotifyTrackId, TRACK_ID);

  assert.equal(calls.length, 1);
});

test('reports lucky picks as unavailable while backing off', async () => {
  const { fetch, calls } = fakeFetch(rateLimited('60'));
  const page: CatalogTrack[] = [{ spotifyTrackId: TRACK_ID, title: 'T', artist: 'A' }];
  const spotify: TrackCatalog = {
    market: 'US',
    findTrackId: async () => null,
    searchTracks: async () => page,
  };
  const engine = createEngine([], spotify, KEEP_ORDER, reccoBeats(fetch, () => 0));

  await assert.rejects(engine.luckySong(), UpstreamError);
  await assert.rejects(engine.luckySong(), UpstreamError);

  assert.equal(calls.length, 1);
});
