import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  InvalidBpmError,
  LuckyDisabledError,
  NoLuckyPickError,
  NoMatchError,
  UpstreamError,
  type TempoEngine,
} from '@tempo-match/engine';
import { contentVersion } from '../src/asset-version.ts';
import { webServer } from '../src/server.ts';

const SONG = { title: 'Song', artist: 'Artist', bpm: 120, spotifyTrackId: '1' };
const LUCKY_SONG = { title: 'Lucky', artist: 'Artist', bpm: 97, spotifyTrackId: '2' };

const markets: (string | undefined)[] = [];
const excludes: (number | undefined)[] = [];
let luck: Error | null = null;

const engine: TempoEngine = {
  async matchSong(bpm, market) {
    markets.push(market);
    if (bpm === 120) {
      return SONG;
    }
    if (bpm === 41) {
      throw new NoMatchError(bpm);
    }
    if (bpm === 99) {
      throw new UpstreamError('Spotify search', 503);
    }
    throw new InvalidBpmError(bpm, 40, 220);
  },
  async luckySong(market, excludeBpm) {
    markets.push(market);
    excludes.push(excludeBpm);
    if (luck) {
      throw luck;
    }
    return LUCKY_SONG;
  },
};

function versionOf(file: string): string {
  return contentVersion(readFileSync(new URL(`../public/${file}`, import.meta.url)));
}

const server = webServer(engine);
let base = '';

function rawStatusLine(target: string): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = connect(port, 'localhost', () => {
      socket.end(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response.split('\r\n')[0]));
    socket.on('error', reject);
  });
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('serves the page', async () => {
  const res = await fetch(`${base}/`);

  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Tempo Match: find a Spotify song at any BPM<\/title>/);
});

test('serves the page script', async () => {
  const res = await fetch(`${base}/app.js`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('serves the theme stylesheet', async () => {
  const res = await fetch(`${base}/theme.css`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await res.text(), /@media \(prefers-color-scheme: dark\)/);
});

const IMAGES = [
  ['/favicon.svg', 'image/svg+xml'],
  ['/favicon-32.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/og-image.png', 'image/png'],
] as const;

for (const [path, type] of IMAGES) {
  test(`serves ${path} as ${type}`, async () => {
    const res = await fetch(`${base}${path}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), type);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
  });
}

for (const page of ['/', '/privacy', '/terms']) {
  test(`links the favicons and describes ${page}`, async () => {
    const html = await (await fetch(`${base}${page}`)).text();

    assert.ok(html.includes(`<link rel="icon" href="/favicon.svg?v=${versionOf('favicon.svg')}" type="image/svg+xml">`));
    assert.ok(html.includes(
      `<link rel="icon" href="/favicon-32.png?v=${versionOf('favicon-32.png')}" type="image/png" sizes="32x32">`,
    ));
    assert.ok(html.includes(`<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${versionOf('apple-touch-icon.png')}">`));
    assert.match(html, /<meta name="description" content="[^"]{1,160}">/);
    assert.ok(html.includes(`<link rel="stylesheet" href="/theme.css?v=${versionOf('theme.css')}">`));
  });
}

test('loads the page script by its content version', async () => {
  const html = await (await fetch(`${base}/`)).text();

  assert.ok(html.includes(`<script src="/app.js?v=${versionOf('app.js')}"></script>`));
});

test('shares the page with an absolute preview image', async () => {
  const html = await (await fetch(`${base}/`)).text();

  assert.match(html, /<link rel="canonical" href="https:\/\/tempo-match\.hadalin\.me\/">/);
  const image = `https://tempo-match.hadalin.me/og-image.png?v=${versionOf('og-image.png')}`;
  assert.ok(html.includes(`<meta property="og:image" content="${image}">`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${image}">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

for (const path of ['/', '/privacy', '/terms', '/app.js', '/theme.css', '/favicon.svg', '/og-image.png', '/api/song?bpm=120', '/missing']) {
  test(`sends security headers on ${path}`, async () => {
    const res = await fetch(`${base}${path}`);
    const csp = res.headers.get('content-security-policy') ?? '';

    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-src https:\/\/open\.spotify\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /img-src 'self'/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });
}

for (const path of ['/api/song?bpm=120', '/api/song?bpm=abc', '/api/song?lucky=1', '/api/missing']) {
  test(`forbids caching ${path}`, async () => {
    luck = null;

    const res = await fetch(`${base}${path}`);

    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
}

for (const page of ['/', '/privacy', '/terms']) {
  test(`makes caches revalidate ${page}`, async () => {
    const res = await fetch(`${base}${page}`);

    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
}

const ASSETS = [
  ['/app.js', 'app.js'],
  ['/theme.css', 'theme.css'],
  ['/favicon.svg', 'favicon.svg'],
  ['/favicon-32.png', 'favicon-32.png'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['/og-image.png', 'og-image.png'],
] as const;

for (const [path, file] of ASSETS) {
  test(`caches ${path} for a year at its current version`, async () => {
    const res = await fetch(`${base}${path}?v=${versionOf(file)}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  for (const query of ['', '?v=0000000000']) {
    test(`caches ${path}${query} briefly`, async () => {
      const res = await fetch(`${base}${path}${query}`);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    });
  }
}

for (const [path, title] of [['/privacy', 'Privacy'], ['/terms', 'Terms']] as const) {
  test(`serves ${path} and links it from the page footer`, async () => {
    const res = await fetch(`${base}${path}`);
    const index = await (await fetch(`${base}/`)).text();

    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(`<title>${title} · Tempo Match</title>`));
    assert.match(index, new RegExp(`<footer>[\\s\\S]*href="${path}"[\\s\\S]*</footer>`));
  });
}

test('leaves the data credit out of the page footer', async () => {
  const index = await (await fetch(`${base}/`)).text();
  const footer = index.match(/<footer>[\s\S]*<\/footer>/)?.[0] ?? '';

  assert.match(footer, /href="\/privacy"/);
  assert.doesNotMatch(footer, /Tempo data by|GetSongBPM|Deezer|ReccoBeats|Tracks from Spotify/);
});

test('links GetSongBPM and names every data source on the terms and privacy pages', async () => {
  for (const path of ['/terms', '/privacy']) {
    const html = await (await fetch(`${base}${path}`)).text();

    assert.match(html, /<a href="https:\/\/getsongbpm\.com">GetSongBPM<\/a>/);
    for (const source of ['Deezer', 'ReccoBeats', 'Spotify']) {
      assert.match(html, new RegExp(source));
    }
  }
});

test('returns the matched song', async () => {
  const res = await fetch(`${base}/api/song?bpm=120`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), SONG);
});

const COUNTRY_CASES = [
  ['SI', 'SI'],
  ['si', 'SI'],
  ['XX', undefined],
  ['T1', undefined],
  ['S1', undefined],
  ['USA', undefined],
  ['', undefined],
  [null, undefined],
] as const;

for (const [country, market] of COUNTRY_CASES) {
  test(`searches CF-IPCountry ${country} in market ${market}`, async () => {
    const headers: Record<string, string> = country === null ? {} : { 'CF-IPCountry': country };
    markets.length = 0;

    await fetch(`${base}/api/song?bpm=120`, { headers });

    assert.deepEqual(markets, [market]);
  });
}

for (const [bpm, status] of [
  ['abc', 400],
  ['41', 404],
  ['99', 502],
  ['120.0', 400],
  ['0x78', 400],
  ['1e2', 400],
  ['%2B120', 400],
  ['%20120', 400],
] as const) {
  test(`maps bpm=${bpm} to HTTP ${status}`, async () => {
    const res = await fetch(`${base}/api/song?bpm=${bpm}`);

    assert.equal(res.status, status);
    assert.equal(typeof (await res.json()).error, 'string');
  });
}

for (const target of ['//', '//[']) {
  test(`answers request target ${target} with 404 and keeps serving`, async () => {
    assert.equal(await rawStatusLine(target), 'HTTP/1.1 404 Not Found');
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
}

test('returns a lucky song for lucky=1 in the visitor market', async () => {
  luck = null;
  markets.length = 0;

  const res = await fetch(`${base}/api/song?lucky=1`, { headers: { 'CF-IPCountry': 'SI' } });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), LUCKY_SONG);
  assert.deepEqual(markets, ['SI']);
});

test('ignores bpm on a lucky request', async () => {
  luck = null;

  const res = await fetch(`${base}/api/song?lucky=1&bpm=120`);

  assert.deepEqual(await res.json(), LUCKY_SONG);
});

test('passes a valid exclude BPM to a lucky pick', async () => {
  luck = null;
  excludes.length = 0;

  await fetch(`${base}/api/song?lucky=1&exclude=120`);

  assert.deepEqual(excludes, [120]);
});

for (const exclude of ['', 'abc', '120.5', '39', '221', '1e2', '120.0', '0x78', '%2B120']) {
  test(`ignores an invalid exclude of "${exclude}"`, async () => {
    luck = null;
    excludes.length = 0;

    const res = await fetch(`${base}/api/song?lucky=1&exclude=${exclude}`);

    assert.equal(res.status, 200);
    assert.deepEqual(excludes, [undefined]);
  });
}

test('treats a lucky value other than 1 as a normal search', async () => {
  const res = await fetch(`${base}/api/song?lucky=yes`);

  assert.equal(res.status, 400);
});

for (const [label, error, status, message] of [
  ['finds nothing', new NoLuckyPickError(), 404, "Couldn't find a lucky song, try again"],
  ['is turned off', new LuckyDisabledError(), 503, "I'm feeling lucky is turned off on this server"],
  [
    'hits a failing service',
    new UpstreamError('ReccoBeats', 503),
    502,
    'A music service is unavailable, try again later',
  ],
] as const) {
  test(`answers HTTP ${status} when lucky ${label}`, async () => {
    luck = error;

    const res = await fetch(`${base}/api/song?lucky=1`);

    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: message });
  });
}
