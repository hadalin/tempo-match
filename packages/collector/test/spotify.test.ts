import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { UNTIL_UNBLOCKED } from '@tempo-match/catalog';
import { CallKind, dispatcher } from '../src/dispatcher.ts';
import { ResponseFormatError } from '../src/errors.ts';
import { SPOTIFY } from '../src/policies.ts';
import { spotify, type LookupSong } from '../src/spotify.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock } from './fake-clock.ts';
import { fakeFetch, json, type Route } from './fake-fetch.ts';

const ID = '4cOdK2wGLETKBW3PvgPWqT';
const OTHER = '0VjIjW4GlUZAMYd2vXMi3b';
const SONG: LookupSong = { title: 'Dreams', artist: 'Fleetwood Mac', isrc: null };
const ISRC = 'USWB10400046';

function track(extra: Record<string, unknown> = {}) {
  return { id: ID, name: 'Dreams', artists: [{ name: 'Fleetwood Mac' }], duration_ms: 257_000, is_playable: true, ...extra };
}

function setup(searches: (url: URL) => unknown[]) {
  const { db } = memoryCatalog();
  const clock = fakeClock();
  const route: Route = (url) => {
    if (url.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'token', expires_in: 3600 });
    }
    return json({ tracks: { items: searches(url) } });
  };
  const { fetch, calls } = fakeFetch(route);
  const lookup = spotify({ clientId: 'id', clientSecret: 'secret' }, dispatcher(db, SPOTIFY, clock), fetch, clock.now);
  const searched = () => calls.filter((c) => c.url.hostname === 'api.spotify.com').map((c) => c.url);
  return { db, lookup, calls, searched };
}

test('authenticates with client credentials once and counts the token call', async () => {
  const { db, lookup, calls } = setup(() => [track()]);

  await lookup.lookup(SONG, 'US', CallKind.Plain);
  await lookup.lookup(SONG, 'US', CallKind.Plain);

  const tokens = calls.filter((c) => c.url.hostname === 'accounts.spotify.com');
  assert.equal(tokens.length, 1);
  assert.equal(new Headers(tokens[0].init?.headers).get('Authorization'), `Basic ${btoa('id:secret')}`);
  assert.equal(db.prepare("SELECT calls FROM upstream WHERE service = 'spotify'").get()?.calls, 3);
});

test('searches by title and artist in the market and returns the playable match', async () => {
  const { lookup, searched } = setup(() => [track({ id: OTHER, name: 'Dreams (Live)', artists: [{ name: 'Other' }] }), track()]);

  assert.equal(await lookup.lookup(SONG, 'SI', CallKind.Plain), ID);

  const [url] = searched();
  assert.equal(url.searchParams.get('q'), 'track:"Dreams" artist:"Fleetwood Mac"');
  assert.equal(url.searchParams.get('market'), 'SI');
  assert.equal(url.searchParams.get('type'), 'track');
});

test('matches a title with a remaster suffix and artists ignoring case and diacritics', async () => {
  const { lookup } = setup(() => [track({ name: 'Dreams - 2004 Remaster', artists: [{ name: 'FLEETWOOD MÁC' }] })]);

  assert.equal(await lookup.lookup(SONG, 'US', CallKind.Plain), ID);
});

const UNPLAYABLE = [
  ['marked unplayable', { is_playable: false }],
  ['restricted in the market', { restrictions: { reason: 'market' } }],
  ['shorter than 90 seconds', { duration_ms: 60_000 }],
] as const;

for (const [label, extra] of UNPLAYABLE) {
  test(`skips a track ${label}`, async () => {
    const { lookup } = setup(() => [track(extra)]);

    assert.equal(await lookup.lookup(SONG, 'US', CallKind.Plain), null);
  });
}

test('looks a song up by ISRC first and trusts that match whatever its title', async () => {
  const { lookup, searched } = setup(() => [track({ name: 'Something else' })]);

  assert.equal(await lookup.lookup({ ...SONG, isrc: ISRC }, 'US', CallKind.Plain), ID);
  assert.deepEqual(searched().map((url) => url.searchParams.get('q')), [`isrc:${ISRC}`]);
});

test('falls back to title and artist when the ISRC finds nothing playable', async () => {
  const { lookup, searched } = setup((url) =>
    url.searchParams.get('q')!.startsWith('isrc:') ? [track({ is_playable: false })] : [track({ id: OTHER })]);

  assert.equal(await lookup.lookup({ ...SONG, isrc: ISRC }, 'US', CallKind.Plain), OTHER);
  assert.equal(searched().length, 2);
});

test('skips a malformed ISRC', async () => {
  const { lookup, searched } = setup(() => [track()]);

  await lookup.lookup({ ...SONG, isrc: 'not-an-isrc' }, 'US', CallKind.Plain);

  assert.deepEqual(searched().map((url) => url.searchParams.get('q')), ['track:"Dreams" artist:"Fleetwood Mac"']);
});

test('holds Spotify and stores nothing when results lack is_playable', async () => {
  const { db, lookup } = setup(() => [track({ is_playable: undefined })]);
  mock.method(console, 'error', () => {});

  await assert.rejects(lookup.lookup(SONG, 'US', CallKind.Plain), ResponseFormatError);

  assert.equal(db.prepare("SELECT held_until FROM upstream WHERE service = 'spotify'").get()?.held_until, UNTIL_UNBLOCKED);
  assert.equal(db.prepare('SELECT count(*) AS n FROM misses').get()?.n, 0);
});

test('counts both searches of a re-check against the re-check share', async () => {
  const { db, lookup } = setup((url) => (url.searchParams.get('q')!.startsWith('isrc:') ? [] : [track()]));

  await lookup.lookup({ ...SONG, isrc: ISRC }, 'US', CallKind.Recheck);

  assert.deepEqual({ ...db.prepare("SELECT calls, recheck_calls FROM upstream WHERE service = 'spotify'").get() }, {
    calls: 3,
    recheck_calls: 2,
  });
});
