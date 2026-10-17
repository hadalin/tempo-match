import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spotify, UpstreamError } from '../src/index.ts';
import { fakeFetch, json, type Call, type Route } from './fake-fetch.ts';

const CREDS = { clientId: 'id', clientSecret: 'secret', market: 'US' };

function track(artist: string, id: string, name = 'Song', durationMs = 200_000) {
  return {
    id,
    name,
    duration_ms: durationMs,
    artists: [{ name: artist }],
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

function tokenRequests(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.hostname === 'accounts.spotify.com');
}

function searchRequests(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.pathname === '/v1/search');
}

function routes(items: unknown[], tokenStatus = 200): Route {
  return (url) => {
    if (url.href === 'https://accounts.spotify.com/api/token') {
      return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }, tokenStatus);
    }
    if (url.pathname === '/v1/search') {
      return json({ tracks: { items } });
    }
    return undefined;
  };
}

test('authenticates with client credentials', async () => {
  const { fetch, calls } = fakeFetch(routes([track('Eagles', '1')]));

  await spotify(CREDS, fetch).findTrackId({ title: 'Hotel California', artist: 'Eagles' });

  const init = calls[0].init!;
  assert.equal(init.method, 'POST');
  assert.equal(String(init.body), 'grant_type=client_credentials');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
});

test('searches by track and artist and returns the matching track id', async () => {
  const { fetch, calls } = fakeFetch(
    routes([
      track('Eagles Tribute Band', 'cover', 'Hotel California'),
      track('Eagles', 'original', 'Hotel California'),
    ]),
  );

  const id = await spotify(CREDS, fetch).findTrackId({
    title: 'Hotel California',
    artist: 'Eagles',
  });

  assert.equal(id, 'original');
  const search = calls[1];
  assert.equal(search.url.searchParams.get('q'), 'track:"Hotel California" artist:"Eagles"');
  assert.equal(search.url.searchParams.get('type'), 'track');
  assert.equal(search.url.searchParams.get('market'), 'US');
  assert.deepEqual(search.init?.headers, { Authorization: 'Bearer tok' });
});

test('matches artists ignoring case and diacritics', async () => {
  const { fetch } = fakeFetch(routes([track('Beyoncé', 'b', 'Halo')]));

  const id = await spotify(CREDS, fetch).findTrackId({ title: 'Halo', artist: 'beyonce' });

  assert.equal(id, 'b');
});

test('skips a result by the artist whose title only starts like the song', async () => {
  const { fetch } = fakeFetch(
    routes([track('Prunella Scales', 'reading', 'When All the World Is Young, Lad')]),
  );

  const id = await spotify(CREDS, fetch).findTrackId({ title: 'When', artist: 'Prunella Scales' });

  assert.equal(id, null);
});

test('matches a title with a remaster or featured-artist suffix', async () => {
  const { fetch } = fakeFetch(
    routes([track('Rihanna', 'stay', 'Stay (feat. Mikky Ekko) - Remastered 2011')]),
  );

  const id = await spotify(CREDS, fetch).findTrackId({ title: 'Stay', artist: 'Rihanna' });

  assert.equal(id, 'stay');
});

test('skips results shorter than 90 seconds', async () => {
  const { fetch } = fakeFetch(
    routes([
      track('Eagles', 'short', 'Hotel California', 89_999),
      track('Eagles', 'full', 'Hotel California', 90_000),
    ]),
  );

  const id = await spotify(CREDS, fetch).findTrackId({
    title: 'Hotel California',
    artist: 'Eagles',
  });

  assert.equal(id, 'full');
});

test('returns null when no result is by the artist', async () => {
  const { fetch } = fakeFetch(routes([track('Someone Else', 'x')]));

  const id = await spotify(CREDS, fetch).findTrackId({ title: 'Halo', artist: 'Beyoncé' });

  assert.equal(id, null);
});

test('reuses the token until it nears expiry', async () => {
  const { fetch, calls } = fakeFetch(routes([]));
  let clock = 0;
  const catalog = spotify(CREDS, fetch, () => clock);

  await catalog.findTrackId({ title: 'a', artist: 'b' });
  await catalog.findTrackId({ title: 'c', artist: 'd' });
  clock = 3600 * 1000;
  await catalog.findTrackId({ title: 'e', artist: 'f' });

  assert.equal(tokenRequests(calls).length, 2);
});

test('shares one pending token request between concurrent searches', async () => {
  const pendingToken = Promise.withResolvers<Response>();
  const search = routes([]);
  const { fetch, calls } = fakeFetch((url, init) =>
    url.hostname === 'accounts.spotify.com' ? pendingToken.promise : search(url, init),
  );
  const catalog = spotify(CREDS, fetch);

  const searches = Promise.all([
    catalog.findTrackId({ title: 'a', artist: 'b' }),
    catalog.findTrackId({ title: 'c', artist: 'd' }),
  ]);
  pendingToken.resolve(json({ access_token: 'tok', expires_in: 3600 }));
  await searches;

  assert.equal(tokenRequests(calls).length, 1);
  assert.equal(searchRequests(calls).length, 2);
});

test('requests a new token after a failed one', async () => {
  let tokenStatus = 500;
  const { fetch, calls } = fakeFetch((url, init) => routes([], tokenStatus)(url, init));
  const catalog = spotify(CREDS, fetch);

  await assert.rejects(catalog.findTrackId({ title: 'a', artist: 'b' }), UpstreamError);
  tokenStatus = 200;
  await catalog.findTrackId({ title: 'a', artist: 'b' });

  assert.equal(tokenRequests(calls).length, 2);
});

test('caches found and missing tracks until the cache entry expires', async () => {
  const { fetch, calls } = fakeFetch(routes([track('Eagles', '1', 'Hotel California')]));
  let clock = 0;
  const catalog = spotify(CREDS, fetch, () => clock);

  const searches = await Promise.all([
    catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' }),
    catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' }),
    catalog.findTrackId({ title: 'Halo', artist: 'Beyoncé' }),
  ]);
  await catalog.findTrackId({ title: 'Halo', artist: 'Beyoncé' });
  clock = 25 * 3600 * 1000;
  await catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' });

  assert.deepEqual(searches, ['1', '1', null]);
  assert.equal(searchRequests(calls).length, 3);
});

test('searches in the market passed to the call', async () => {
  const { fetch, calls } = fakeFetch(routes([]));

  await spotify(CREDS, fetch).findTrackId({ title: 'a', artist: 'b' }, 'SI');

  assert.equal(searchRequests(calls)[0].url.searchParams.get('market'), 'SI');
});

test('keeps cached tracks apart per market', async () => {
  const { fetch, calls } = fakeFetch(routes([track('Eagles', '1')]));
  const catalog = spotify(CREDS, fetch);

  await catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' });
  await catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' }, 'SI');
  await catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' }, 'US');
  await catalog.findTrackId({ title: 'Hotel California', artist: 'Eagles' }, 'SI');

  const markets = searchRequests(calls).map((c) => c.url.searchParams.get('market'));
  assert.deepEqual(markets, ['US', 'SI']);
});

test('bounds every request with a timeout', async () => {
  const { fetch, calls } = fakeFetch(routes([]));

  await spotify(CREDS, fetch).findTrackId({ title: 'a', artist: 'b' });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test('throws UpstreamError when authentication fails', async () => {
  const { fetch } = fakeFetch(routes([], 400));

  await assert.rejects(
    spotify(CREDS, fetch).findTrackId({ title: 'a', artist: 'b' }),
    UpstreamError,
  );
});

function isrcRoutes(isrcItems: unknown[], titleItems: unknown[]): Route {
  return (url, init) => {
    if (url.searchParams.get('q')?.startsWith('isrc:')) {
      return json({ tracks: { items: isrcItems } });
    }
    return routes(titleItems)(url, init);
  };
}

const WITH_ISRC = { title: 'Dreams', artist: 'Fleetwood Mac', isrc: 'USWB10400046' };

test('looks a track up by ISRC first', async () => {
  const { fetch, calls } = fakeFetch(isrcRoutes([track('Fleetwood Mac', 'exact')], []));

  const id = await spotify(CREDS, fetch).findTrackId(WITH_ISRC, 'SI');

  assert.equal(id, 'exact');
  const searches = searchRequests(calls);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].url.searchParams.get('q'), 'isrc:USWB10400046');
  assert.equal(searches[0].url.searchParams.get('type'), 'track');
  assert.equal(searches[0].url.searchParams.get('market'), 'SI');
});

test('falls back to title and artist when the ISRC finds nothing', async () => {
  const { fetch, calls } = fakeFetch(
    isrcRoutes([], [track('Fleetwood Mac', 'by-title', 'Dreams')]),
  );

  const id = await spotify(CREDS, fetch).findTrackId(WITH_ISRC);

  assert.equal(id, 'by-title');
  assert.deepEqual(
    searchRequests(calls).map((c) => c.url.searchParams.get('q')),
    ['isrc:USWB10400046', 'track:"Dreams" artist:"Fleetwood Mac"'],
  );
});

test('trusts the ISRC match whatever its title', async () => {
  const { fetch } = fakeFetch(isrcRoutes([track('Fleetwood Mac', 'exact', 'Dreams - Live')], []));

  const id = await spotify(CREDS, fetch).findTrackId(WITH_ISRC);

  assert.equal(id, 'exact');
});

test('skips a short ISRC match without searching by title', async () => {
  const short = track('Fleetwood Mac', 'short', 'Dreams', 60_000);
  const { fetch, calls } = fakeFetch(isrcRoutes([short], [track('Fleetwood Mac', 'x', 'Dreams')]));

  const id = await spotify(CREDS, fetch).findTrackId(WITH_ISRC);

  assert.equal(id, null);
  assert.equal(searchRequests(calls).length, 1);
});

test('skips a malformed ISRC', async () => {
  const { fetch, calls } = fakeFetch(isrcRoutes([track('A', 'x')], []));

  await spotify(CREDS, fetch).findTrackId({ title: 'a', artist: 'b', isrc: 'X" OR 1' });

  assert.deepEqual(
    searchRequests(calls).map((c) => c.url.searchParams.get('q')),
    ['track:"a" artist:"b"'],
  );
});

test('caches ISRC lookups per market', async () => {
  const { fetch, calls } = fakeFetch(isrcRoutes([track('Fleetwood Mac', 'exact')], []));
  const catalog = spotify(CREDS, fetch);

  await catalog.findTrackId(WITH_ISRC);
  await catalog.findTrackId(WITH_ISRC);
  await catalog.findTrackId(WITH_ISRC, 'SI');

  const markets = searchRequests(calls).map((c) => c.url.searchParams.get('market'));
  assert.deepEqual(markets, ['US', 'SI']);
});

test('searches a page of tracks for a term at an offset', async () => {
  const noArtist = { ...track('', 'no-artist'), artists: [] };
  const short = track('Poet', 'short', 'Love', 60_000);
  const { fetch, calls } = fakeFetch(routes([track('Tom Odell', 'love'), noArtist, short]));

  const tracks = await spotify(CREDS, fetch).searchTracks('love', 120, 'SI');

  assert.deepEqual(tracks, [{ spotifyTrackId: 'love', title: 'Song', artist: 'Tom Odell' }]);
  const { searchParams } = searchRequests(calls)[0].url;
  assert.equal(searchParams.get('q'), 'love');
  assert.equal(searchParams.get('type'), 'track');
  assert.equal(searchParams.get('market'), 'SI');
  assert.equal(searchParams.get('limit'), '10');
  assert.equal(searchParams.get('offset'), '120');
});

test('caches search pages per market, term and offset', async () => {
  const { fetch, calls } = fakeFetch(routes([track('A', '1')]));
  const catalog = spotify(CREDS, fetch);

  await catalog.searchTracks('love', 0);
  await catalog.searchTracks('love', 0, 'US');
  await catalog.searchTracks('love', 10);
  await catalog.searchTracks('night', 0);
  await catalog.searchTracks('love', 0, 'SI');

  assert.equal(searchRequests(calls).length, 4);
});
