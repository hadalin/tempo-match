import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { deezer } from '../src/deezer.ts';
import { dispatcher } from '../src/dispatcher.ts';
import { UnavailableError } from '../src/errors.ts';
import { getSongBpm } from '../src/getsongbpm.ts';
import { DEEZER, GETSONGBPM, RECCOBEATS } from '../src/policies.ts';
import { reccoBeats } from '../src/reccobeats.ts';
import { isNonSong } from '../src/title-filter.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock } from './fake-clock.ts';
import { fakeFetch, json, type Route } from './fake-fetch.ts';

const ID = '4cOdK2wGLETKBW3PvgPWqT';
const OTHER = '0VjIjW4GlUZAMYd2vXMi3b';

function calls(policy = GETSONGBPM) {
  const { db } = memoryCatalog();
  return { db, calls: dispatcher(db, policy, fakeClock()) };
}

test('GetSongBPM: asks the tempo endpoint with the key and a large page', async () => {
  const { fetch, calls: requests } = fakeFetch(() => json({ tempo: [] }));

  await getSongBpm('key', calls().calls, fetch)(120);

  const { url, init } = requests[0];
  assert.equal(url.origin + url.pathname, 'https://api.getsong.co/tempo/');
  assert.equal(url.searchParams.get('bpm'), '120');
  assert.equal(url.searchParams.get('limit'), '1000');
  assert.equal(new Headers(init?.headers).get('X-API-KEY'), 'key');
  assert.ok(init?.signal instanceof AbortSignal);
});

test('GetSongBPM: keeps complete entries at exactly the BPM, most viewed most popular', async () => {
  const tempo = [
    { song_title: 'First', tempo: '120', artist: { name: 'A' } },
    { song_title: 'Faster', tempo: '121', artist: { name: 'A' } },
    { song_title: 'No artist', tempo: '120' },
    { song_title: 'Last', tempo: 120, artist: { name: 'B' } },
  ];
  const { fetch } = fakeFetch(() => json({ tempo }));

  const songs = await getSongBpm('key', calls().calls, fetch)(120);

  assert.deepEqual(songs, [
    { title: 'First', artist: 'A', popularity: 1 },
    { title: 'Last', artist: 'B', popularity: 0.25 },
  ]);
});

test('GetSongBPM: treats a non-array payload as no songs', async () => {
  const { fetch } = fakeFetch(() => json({ tempo: { error: 'no result' } }));

  assert.deepEqual(await getSongBpm('key', calls().calls, fetch)(44), []);
});

test('Deezer: queries one BPM with quoted filters, a seed, a page size and an index', async () => {
  const { fetch, calls: requests } = fakeFetch(() => json({ data: [] }));

  await deezer(calls(DEEZER).calls, fetch)(120, 'track:"a"', 100);

  const { url } = requests[0];
  assert.equal(url.origin + url.pathname, 'https://api.deezer.com/search/track');
  assert.equal(url.searchParams.get('q'), 'track:"a" bpm_min:"120" bpm_max:"120"');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('index'), '100');
});

test('Deezer: keeps known tracks at the BPM with ISRC, duration and rank as popularity', async () => {
  const data = [
    { title: 'Dreams', isrc: 'USWB10400046', rank: 900_000, duration: 257, artist: { name: 'Fleetwood Mac' } },
    { title: 'Obscure', rank: 500, artist: { name: 'A' } },
    { title: 'Faster', rank: 900_000, bpm: 121.4, artist: { name: 'A' } },
    { title: 'No artist', rank: 900_000 },
    { title: 'No ISRC', rank: 2_000_000, artist: { name: 'B' } },
  ];
  const { fetch } = fakeFetch(() => json({ data }));

  const page = await deezer(calls(DEEZER).calls, fetch)(120, '', 0);

  assert.equal(page.rows, 5);
  assert.deepEqual(page.songs, [
    { title: 'Dreams', artist: 'Fleetwood Mac', popularity: 0.9, isrc: 'USWB10400046', durationS: 257 },
    { title: 'No ISRC', artist: 'B', popularity: 1 },
  ]);
});

test('Deezer: an error object sent with HTTP 200 backs off like an outage', async () => {
  const { db, calls: deezerCalls } = calls(DEEZER);
  const { fetch } = fakeFetch(() => json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }));
  mock.method(console, 'error', () => {});

  await assert.rejects(deezer(deezerCalls, fetch)(120, '', 0), UnavailableError);

  assert.ok(Number(db.prepare("SELECT banned_until FROM upstream WHERE service = 'deezer'").get()?.banned_until) > 0);
});

test('ReccoBeats: asks for a batch of ids and matches rows by link', async () => {
  const content = [
    { href: `https://open.spotify.com/track/${OTHER}`, tempo: 0, speechiness: 0.9 },
    { href: `https://open.spotify.com/track/${ID}`, tempo: 121.5, speechiness: 0.05 },
  ];
  const { fetch, calls: requests } = fakeFetch(() => json({ content }));
  const missing = 'M'.repeat(22);

  const features = await reccoBeats(calls(RECCOBEATS).calls, fetch).featuresOf([ID, OTHER, missing]);

  assert.equal(requests[0].url.searchParams.get('ids'), `${ID},${OTHER},${missing}`);
  assert.deepEqual([...features], [
    [ID, { tempo: 121.5, speechiness: 0.05 }],
    [OTHER, { tempo: null, speechiness: 0.9 }],
    [missing, null],
  ]);
});

for (const [service, fetchOne] of [
  ['GetSongBPM', (fetch: typeof globalThis.fetch) => getSongBpm('key', calls().calls, fetch)(120)],
  ['Deezer', (fetch: typeof globalThis.fetch) => deezer(calls(DEEZER).calls, fetch)(120, '', 0)],
  ['ReccoBeats', (fetch: typeof globalThis.fetch) => reccoBeats(calls(RECCOBEATS).calls, fetch).featuresOf([ID])],
] as const) {
  test(`${service}: an unreachable service is an outage`, async () => {
    const failure = new TypeError('fetch failed');
    mock.method(console, 'error', () => {});
    const route: Route = () => {
      throw failure;
    };

    await assert.rejects(fetchOne(fakeFetch(route).fetch), (err) => err instanceof UnavailableError && err.cause === failure);
  });
}

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

for (const [title, nonSong] of TITLE_CASES) {
  test(`${nonSong ? 'drops' : 'keeps'} the provider title "${title}"`, () => {
    assert.equal(isNonSong(title), nonSong);
  });
}
