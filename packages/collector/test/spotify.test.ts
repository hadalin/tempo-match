import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { UNTIL_UNBLOCKED, utcDay } from '@tempo-match/catalog';
import { CallKind, dispatcher } from '../src/dispatcher.ts';
import { RefusedError, ResponseFormatError, UnauthorizedError } from '../src/errors.ts';
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

const TOKEN_SECONDS = 3600;

/**
 * A fake Spotify whose tokens expire after TOKEN_SECONDS, that answers 401 to the first `refused`
 * searches and 400 invalid_client to every token request after the first `tokens`.
 */
function expiringSetup(refused = 0, tokens = Infinity) {
  const { db } = memoryCatalog();
  const clock = fakeClock();
  const issued = new Map<string, number>();
  let refusals = refused;
  const route: Route = (url, init) => {
    if (url.hostname === 'accounts.spotify.com') {
      if (issued.size >= tokens) {
        return json({ error: 'invalid_client' }, 400);
      }
      const value = `token-${issued.size + 1}`;
      issued.set(value, clock.now());
      return json({ access_token: value, expires_in: TOKEN_SECONDS });
    }
    const bearer = new Headers(init?.headers).get('Authorization')!.replace('Bearer ', '');
    const expired = clock.now() >= issued.get(bearer)! + TOKEN_SECONDS * 1000;
    if (expired || refusals-- > 0) {
      return json({ error: { status: 401, message: 'The access token expired' } }, 401);
    }
    return json({ tracks: { items: [track()] } });
  };
  const { fetch, calls } = fakeFetch(route);
  const longestGap = () => 1;
  const lookup = spotify({ clientId: 'id', clientSecret: 'secret' }, dispatcher(db, SPOTIFY, clock, longestGap), fetch, clock.now);
  const upstream = () => ({ ...db.prepare("SELECT calls, held_until FROM upstream WHERE service = 'spotify'").get() });
  const bearers = () =>
    calls.filter((c) => c.url.hostname === 'api.spotify.com').map((c) => new Headers(c.init?.headers).get('Authorization'));
  return { db, clock, issued, lookup, upstream, bearers };
}

test('sends a fresh token when the cached one expires while the search waits for its turn', async () => {
  const { clock, issued, lookup, upstream, bearers } = expiringSetup();
  await lookup.lookup(SONG, 'US', CallKind.Plain);

  // 100 s before expiry the token is outside its refresh margin, but the next search waits 130 s.
  clock.advance(issued.get('token-1')! + (TOKEN_SECONDS - 100) * 1000 - clock.now());
  await lookup.lookup(SONG, 'US', CallKind.Plain);
  assert.equal(await lookup.lookup(SONG, 'US', CallKind.Plain), ID);

  assert.deepEqual(bearers(), ['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  assert.equal(upstream().calls, 5);
});

test('recovers from a refused token with one fresh token and counts both requests', async () => {
  const { lookup, upstream, bearers } = expiringSetup(1);

  assert.equal(await lookup.lookup(SONG, 'US', CallKind.Plain), ID);

  assert.deepEqual(bearers(), ['Bearer token-1', 'Bearer token-2']);
  assert.deepEqual(upstream(), { calls: 4, held_until: 0 });
});

test('holds Spotify when a fresh token is refused too', async () => {
  const { lookup, upstream, bearers } = expiringSetup(Infinity);
  mock.method(console, 'error', () => {});

  await assert.rejects(lookup.lookup(SONG, 'US', CallKind.Plain), /Spotify search request failed with HTTP 401/);

  assert.deepEqual(bearers(), ['Bearer token-1', 'Bearer token-2']);
  assert.deepEqual(upstream(), { calls: 4, held_until: UNTIL_UNBLOCKED });
});

test('holds Spotify when its token is refused and the app is removed', async () => {
  const { lookup, upstream, bearers } = expiringSetup(1, 1);
  mock.method(console, 'error', () => {});

  await assert.rejects(lookup.lookup(SONG, 'US', CallKind.Plain), (err) =>
    err instanceof UnauthorizedError && err.message.startsWith('Spotify token'));

  assert.deepEqual(bearers(), ['Bearer token-1']);
  assert.deepEqual(upstream(), { calls: 3, held_until: UNTIL_UNBLOCKED });
});

test('refuses the retry of a refused token when the day has no calls left', async () => {
  const { db, clock, lookup, upstream, bearers } = expiringSetup(1);
  db.prepare("UPDATE upstream SET day = ?, calls = ? WHERE service = 'spotify'").run(utcDay(clock.now()), SPOTIFY.dailyCalls - 2);

  await assert.rejects(lookup.lookup(SONG, 'US', CallKind.Plain), RefusedError);

  assert.deepEqual(bearers(), ['Bearer token-1']);
  assert.deepEqual(upstream(), { calls: SPOTIFY.dailyCalls, held_until: 0 });
});
