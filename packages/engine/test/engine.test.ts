import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fakeFetch, json } from './fake-fetch.ts';
import {
  createEngine,
  engineFromEnv,
  InvalidBpmError,
  MissingConfigError,
  NoMatchError,
  reccoBeats,
  spotify,
  UpstreamError,
  type SongProvider,
  type TempoSong,
  type TrackCatalog,
  type TrackQuery,
} from '../src/index.ts';

const KEEP_ORDER = () => 0.999;

function source(songs: TempoSong[]): SongProvider & { requested: number[] } {
  const requested: number[] = [];
  return {
    requested,
    async songsAt(bpm) {
      requested.push(bpm);
      return songs;
    },
  };
}

function failing(): SongProvider {
  return {
    async songsAt() {
      throw new UpstreamError('GetSongBPM', 503);
    },
  };
}

function catalog(
  ids: Record<string, string>,
): TrackCatalog & { lookups: string[]; markets: (string | undefined)[] } {
  const lookups: string[] = [];
  const markets: (string | undefined)[] = [];
  return {
    lookups,
    markets,
    async findTrackId({ title }, market) {
      lookups.push(title);
      markets.push(market);
      return ids[title] ?? null;
    },
    searchTracks: async () => [],
  };
}

test('returns the first song that resolves on Spotify', async () => {
  const tempo = source([
    { title: 'Missing', artist: 'A', bpm: 120 },
    { title: 'Found', artist: 'B', bpm: 120 },
  ]);
  const spotify = catalog({ Found: 'f' });

  const song = await createEngine([tempo], spotify, KEEP_ORDER).matchSong(120);

  assert.deepEqual(song, {
    title: 'Found',
    artist: 'B',
    bpm: 120,
    spotifyTrackId: 'f',
  });
  assert.deepEqual(tempo.requested, [120]);
  assert.deepEqual(spotify.lookups, ['Missing', 'Found']);
});

test('ignores songs whose tempo differs from the requested BPM', async () => {
  const tempo = source([{ title: 'Off', artist: 'A', bpm: 121 }]);
  const spotify = catalog({ Off: 'o' });

  await assert.rejects(createEngine([tempo], spotify).matchSong(120), NoMatchError);
  assert.deepEqual(spotify.lookups, []);
});

test('gives up after a bounded number of candidates', async () => {
  const songs = Array.from({ length: 20 }, (_, i) => ({ title: `S${i}`, artist: 'A', bpm: 90 }));
  const spotify = catalog({});

  await assert.rejects(createEngine([source(songs)], spotify).matchSong(90), NoMatchError);
  assert.equal(spotify.lookups.length, 5);
});

test('picks among candidates using the random source', async () => {
  const tempo = source([
    { title: 'First', artist: 'A', bpm: 100 },
    { title: 'Second', artist: 'B', bpm: 100 },
  ]);
  const spotify = catalog({ First: 'id1', Second: 'id2' });

  const song = await createEngine([tempo], spotify, () => 0).matchSong(100);

  assert.equal(song.title, 'Second');
});

test('looks tracks up in the requested market', async () => {
  const tempo = source([{ title: 'Found', artist: 'A', bpm: 120 }]);
  const spotify = catalog({ Found: 'f' });
  const engine = createEngine([tempo], spotify);

  await engine.matchSong(120, 'SI');
  await engine.matchSong(120);

  assert.deepEqual(spotify.markets, ['SI', undefined]);
});

test('merges songs from every provider', async () => {
  const first = source([{ title: 'One', artist: 'A', bpm: 120 }]);
  const second = source([{ title: 'Two', artist: 'B', bpm: 120 }]);
  const spotify = catalog({});

  await assert.rejects(
    createEngine([first, second], spotify, KEEP_ORDER).matchSong(120),
    NoMatchError,
  );

  assert.deepEqual(first.requested, [120]);
  assert.deepEqual(second.requested, [120]);
  assert.deepEqual(spotify.lookups, ['One', 'Two']);
});

test('looks up a song listed by several providers once', async () => {
  const first = source([{ title: 'Halo', artist: 'Beyoncé', bpm: 80 }]);
  const second = source([
    { title: ' halo', artist: 'BEYONCE ', bpm: 80 },
    { title: 'Halo', artist: 'Other', bpm: 80 },
  ]);
  const spotify = catalog({});

  await assert.rejects(
    createEngine([first, second], spotify, KEEP_ORDER).matchSong(80),
    NoMatchError,
  );

  assert.deepEqual(spotify.lookups, ['Halo', 'Halo']);
});

test('treats songs with the same ISRC as one song', async () => {
  const first = source([{ title: 'Dreams', artist: 'A', bpm: 120, isrc: 'USWB10400046' }]);
  const second = source([
    { title: 'Dreams (2004 Remaster)', artist: 'A', bpm: 120, isrc: 'USWB10400046' },
    { title: 'Dreams', artist: 'A', bpm: 120, isrc: 'USWB10400047' },
    { title: 'dreams', artist: 'A', bpm: 120 },
  ]);
  const spotify = catalog({});

  await assert.rejects(
    createEngine([first, second], spotify, KEEP_ORDER).matchSong(120),
    NoMatchError,
  );

  assert.deepEqual(spotify.lookups, ['Dreams', 'Dreams']);
});

test('passes the ISRC to the catalog and leaves it out of the match', async () => {
  const isrcs: (string | undefined)[] = [];
  const spotify: TrackCatalog = {
    async findTrackId({ isrc }) {
      isrcs.push(isrc);
      return 'd';
    },
    searchTracks: async () => [],
  };
  const tempo = source([{ title: 'Dreams', artist: 'A', bpm: 120, isrc: 'USWB10400046' }]);

  const song = await createEngine([tempo], spotify).matchSong(120);

  assert.deepEqual(isrcs, ['USWB10400046']);
  assert.deepEqual(song, { title: 'Dreams', artist: 'A', bpm: 120, spotifyTrackId: 'd' });
});

test('keeps the ISRC of a later listing of the same song', async () => {
  const queries: TrackQuery[] = [];
  const spotify: TrackCatalog = {
    async findTrackId({ title, artist, isrc }) {
      queries.push({ title, artist, isrc });
      return 's';
    },
    searchTracks: async () => [],
  };
  const getSongBpm = source([{ title: 'Song', artist: 'A', bpm: 120 }]);
  const deezerLike = source([{ title: 'song', artist: 'a', bpm: 120, isrc: 'USAAA2600000' }]);

  await createEngine([getSongBpm, deezerLike], spotify).matchSong(120);

  assert.deepEqual(queries, [{ title: 'Song', artist: 'A', isrc: 'USAAA2600000' }]);
});

test('keeps an exact-tempo listing when another provider lists the song at a different tempo', async () => {
  const off = source([{ title: 'Song', artist: 'A', bpm: 121 }]);
  const exact = source([{ title: 'Song', artist: 'A', bpm: 120 }]);

  const song = await createEngine([off, exact], catalog({ Song: 's' })).matchSong(120);

  assert.equal(song.bpm, 120);
});

test('uses the remaining providers when one fails', async () => {
  const tempo = source([{ title: 'Found', artist: 'A', bpm: 120 }]);

  const song = await createEngine([failing(), tempo], catalog({ Found: 'f' })).matchSong(120);

  assert.equal(song.spotifyTrackId, 'f');
});

test('reports the provider failure when no other provider has songs', async () => {
  const spotify = catalog({});

  await assert.rejects(createEngine([failing(), source([])], spotify).matchSong(120), UpstreamError);
  assert.deepEqual(spotify.lookups, []);
});

// Titles from the content-quality scout report: its non-song leaks, and real songs it checked.
const TITLE_CASES = [
  ['Love Wins (Original Key Performance Track Without Background Vocals)', true],
  ['Scene 7 - Learn To Speak Properly', true],
  ['Skit 5', true],
  ['Interview with HALIENE', true],
  ['Track Commentary', true],
  ['Billie Jean (Karaoke Version)', true],
  ['Halo (Backing Track)', true],
  ['Dreams (Made Famous by Fleetwood Mac)', true],
  ['Dreams (Originally Performed by Fleetwood Mac)', true],
  ['Valerie (Sound-a-like Version)', true],
  ['Valerie (In the Style of Amy Winehouse)', true],
  ['Kapitel 23', true],
  ['Chapter 1: The Beginning', true],
  ['Capítulo 4', true],
  ['Rozdział 12', true],
  ['Tardes de Bolonha (instrumental)', true],
  ['Hotel California [Instrumental Version]', true],
  ['Handel: Serse, HWV 40, Act 2, Scene 12: Duetto', false],
  ['Intro', false],
  ['Interlude', false],
  ['Interviews', false],
  ['Reprise', false],
  ['Part 2', false],
  ['Behind the Scene 3', false],
  ['Instrumental Love', false],
  ['Skittles', false],
  ['Chapter', false],
  ['Hotel California', false],
] as const;

for (const [title, rejected] of TITLE_CASES) {
  test(`${rejected ? 'rejects' : 'keeps'} the provider title "${title}"`, async () => {
    const spotify = catalog({ [title]: 'id' });

    const match = createEngine([source([{ title, artist: 'A', bpm: 120 }])], spotify).matchSong(120);

    if (rejected) {
      await assert.rejects(match, NoMatchError);
      assert.deepEqual(spotify.lookups, []);
    } else {
      assert.equal((await match).spotifyTrackId, 'id');
    }
  });
}

const POETRY_READING = {
  id: '0c61MQGXBiJKWKz6BUn0q2',
  name: 'When All the World Is Young, Lad',
  artists: [{ name: 'Alan Wheatley' }, { name: 'Prunella Scales' }],
  duration_ms: 60_000,
};
const VALERIE = {
  id: 'valerie',
  name: 'Valerie',
  artists: [{ name: 'Amy Winehouse' }],
  duration_ms: 219_000,
};
const FEATURES: Record<string, { tempo: number; speechiness: number }> = {
  [POETRY_READING.id]: { tempo: 103.7, speechiness: 0.558 },
  [VALERIE.id]: { tempo: 104.1, speechiness: 0.04 },
};

test('skips a poetry reading that shares only the artist, then tries the next song', async () => {
  const tempo = source([
    { title: 'When', artist: 'Prunella Scales', bpm: 104 },
    { title: 'Valerie', artist: 'Amy Winehouse', bpm: 104 },
  ]);
  const { fetch, calls } = fakeFetch((url) => {
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.hostname === 'api.spotify.com') {
      const reading = url.searchParams.get('q')!.includes('Prunella Scales');
      return json({ tracks: { items: [reading ? POETRY_READING : VALERIE] } });
    }
    if (url.hostname === 'api.reccobeats.com') {
      const id = url.searchParams.get('ids')!;
      return json({ content: [{ href: `https://open.spotify.com/track/${id}`, ...FEATURES[id] }] });
    }
    return undefined;
  });
  const catalog = spotify({ clientId: 'id', clientSecret: 's', market: 'US' }, fetch);

  const song = await createEngine([tempo], catalog, KEEP_ORDER, reccoBeats(fetch)).matchSong(104);

  assert.equal(song.spotifyTrackId, VALERIE.id);
  const searches = calls.filter((c) => c.url.pathname === '/v1/search');
  const verifications = calls.filter((c) => c.url.hostname === 'api.reccobeats.com');
  assert.equal(searches.length, 2);
  assert.deepEqual(verifications.map((c) => c.url.searchParams.get('ids')), [VALERIE.id]);
});

test('stops at the first candidate that matches by ISRC and passes the checks', async () => {
  const tempo = source([
    { title: 'Dreams', artist: 'Fleetwood Mac', bpm: 120, isrc: 'USWB10400046' },
    { title: 'Valerie', artist: 'Amy Winehouse', bpm: 120, isrc: 'GBUM70700001' },
  ]);
  const { fetch, calls } = fakeFetch((url) => {
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.hostname === 'api.spotify.com') {
      const id = url.searchParams.get('q')!.replace('isrc:', '');
      return json({ tracks: { items: [{ id, name: 'X', artists: [{ name: 'Y' }], duration_ms: 200_000 }] } });
    }
    if (url.hostname === 'api.reccobeats.com') {
      const id = url.searchParams.get('ids')!;
      return json({ content: [{ href: `https://open.spotify.com/track/${id}`, tempo: 120, speechiness: 0.05 }] });
    }
    return undefined;
  });
  const catalog = spotify({ clientId: 'id', clientSecret: 's', market: 'US' }, fetch);

  const song = await createEngine([tempo], catalog, KEEP_ORDER, reccoBeats(fetch)).matchSong(120);

  assert.equal(song.spotifyTrackId, 'USWB10400046');
  const searches = calls.filter((c) => c.url.pathname === '/v1/search');
  assert.deepEqual(searches.map((c) => c.url.searchParams.get('q')), ['isrc:USWB10400046']);
});

for (const bpm of [39, 221, 120.5, Number.NaN]) {
  test(`rejects BPM ${bpm} without calling APIs`, async () => {
    const tempo = source([]);

    await assert.rejects(createEngine([tempo], catalog({})).matchSong(bpm), InvalidBpmError);
    assert.deepEqual(tempo.requested, []);
  });
}

test('engineFromEnv names every missing variable', () => {
  assert.throws(
    () => engineFromEnv({ SPOTIFY_CLIENT_ID: 'id' }),
    (err: Error) =>
      err instanceof MissingConfigError &&
      err.message.includes('GETSONGBPM_API_KEY') &&
      err.message.includes('SPOTIFY_CLIENT_SECRET') &&
      !err.message.includes('SPOTIFY_CLIENT_ID'),
  );
});

const ENV = { GETSONGBPM_API_KEY: 'k', SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 's' };

async function requestedHosts(env: Record<string, string>, t: TestContext): Promise<string[]> {
  const hosts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    hosts.push(input.hostname);
    return json({ tempo: [], data: [] });
  });
  await assert.rejects(engineFromEnv(env).matchSong(120), NoMatchError);
  return hosts;
}

test('engineFromEnv queries Deezer by default', async (t) => {
  assert.ok((await requestedHosts(ENV, t)).includes('api.deezer.com'));
});

test('engineFromEnv leaves Deezer out when DEEZER_ENABLED is false', async (t) => {
  const hosts = await requestedHosts({ ...ENV, DEEZER_ENABLED: 'false' }, t);

  assert.deepEqual(hosts, ['api.getsong.co']);
});

async function verifiedHosts(env: Record<string, string>, t: TestContext): Promise<string[]> {
  const hosts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    hosts.push(url.hostname);
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.hostname === 'api.spotify.com') {
      return json({ tracks: { items: [{ id: 'x', name: 'S', artists: [{ name: 'A' }] }] } });
    }
    return json({ tempo: [{ song_title: 'S', tempo: '120', artist: { name: 'A' } }], content: [] });
  });
  await engineFromEnv({ ...env, DEEZER_ENABLED: 'false' }).matchSong(120);
  return hosts;
}

test('engineFromEnv verifies tempo on ReccoBeats by default', async (t) => {
  assert.ok((await verifiedHosts(ENV, t)).includes('api.reccobeats.com'));
});

test('engineFromEnv skips ReccoBeats when RECCOBEATS_ENABLED is false', async (t) => {
  const hosts = await verifiedHosts({ ...ENV, RECCOBEATS_ENABLED: 'false' }, t);

  assert.ok(!hosts.includes('api.reccobeats.com'));
});
