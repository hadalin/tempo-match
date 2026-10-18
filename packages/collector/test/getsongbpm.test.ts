import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSongBpm, UpstreamError } from '../src/index.ts';
import { fakeFetch, json } from './fake-fetch.ts';

const TEMPO_RESPONSE = {
  tempo: [
    {
      song_id: 'o2r0L',
      song_title: 'Hotel California',
      song_uri: 'https://getsongbpm.com/song/hotel-california/o2r0L',
      tempo: '120',
      artist: { id: 'nZR', name: 'Eagles', uri: 'https://getsongbpm.com/artist/eagles/nZR' },
      album: { title: 'Hotel California', uri: 'https://getsongbpm.com/album/x', year: 1976 },
    },
    { song_id: 'bad', song_title: 'No Artist', tempo: '120' },
  ],
};

test('requests the tempo endpoint with the key in a header', async () => {
  const { fetch, calls } = fakeFetch(() => json(TEMPO_RESPONSE));

  await getSongBpm('secret-key', fetch).songsAt(120);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.getsong.co/tempo/');
  assert.equal(calls[0].url.searchParams.get('bpm'), '120');
  assert.equal(calls[0].url.searchParams.has('api_key'), false);
  assert.deepEqual(calls[0].init?.headers, { 'X-API-KEY': 'secret-key' });
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test('caches songs per BPM until the cache entry expires', async () => {
  const { fetch, calls } = fakeFetch(() => json(TEMPO_RESPONSE));
  let clock = 0;
  const tempo = getSongBpm('key', fetch, () => clock);

  await Promise.all([tempo.songsAt(120), tempo.songsAt(120)]);
  await tempo.songsAt(121);
  await tempo.songsAt(120);
  clock = 25 * 3600 * 1000;
  await tempo.songsAt(120);

  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get('bpm')),
    ['120', '121', '120'],
  );
});

test('retries after a failed request', async () => {
  let status = 503;
  const { fetch, calls } = fakeFetch(() => json(TEMPO_RESPONSE, status));
  const tempo = getSongBpm('key', fetch);

  await assert.rejects(tempo.songsAt(120), UpstreamError);
  status = 200;
  await tempo.songsAt(120);

  assert.equal(calls.length, 2);
});

test('maps entries to songs and drops incomplete ones', async () => {
  const { fetch } = fakeFetch(() => json(TEMPO_RESPONSE));

  const songs = await getSongBpm('key', fetch).songsAt(120);

  assert.deepEqual(songs, [{ title: 'Hotel California', artist: 'Eagles', bpm: 120 }]);
});

test('treats a non-array payload as no songs', async () => {
  const { fetch } = fakeFetch(() => json({ tempo: { error: 'no result' } }));

  assert.deepEqual(await getSongBpm('key', fetch).songsAt(41), []);
});

test('throws UpstreamError on HTTP failure', async () => {
  const { fetch } = fakeFetch(() => json({ error: 'API Key is missing.' }, 401));

  await assert.rejects(getSongBpm('key', fetch).songsAt(120), UpstreamError);
});
