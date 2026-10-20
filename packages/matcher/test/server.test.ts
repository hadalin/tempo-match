import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { identityOf, openWriter, SOURCE_GETSONGBPM, transitions } from '@tempo-match/catalog';
import { contentVersion } from '../src/asset-version.ts';
import { catalogReader, type CatalogReader } from '../src/catalog-reader.ts';
import { flags } from '../src/flags.ts';
import { matcherServer } from '../src/server.ts';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);
const LUCKY = 'L'.repeat(22);
const NOW = Date.UTC(2026, 9, 18, 12);
const SONGS = [
  { title: 'Song', bpm: 120, id: A },
  { title: 'Other', bpm: 120, id: B },
  { title: 'Lucky', bpm: 97, id: LUCKY },
];

const dir = mkdtempSync(join(tmpdir(), 'matcher-'));
const path = join(dir, 'catalog.db');
const writer = openWriter(path);
const t = transitions(writer);
for (const { title, bpm, id } of SONGS) {
  const identity = identityOf(title, 'Artist');
  t.upsertListings([{ identity, bpm, title, artist: 'Artist', popularity: 0.5, source: SOURCE_GETSONGBPM }], NOW);
  t.applyLookup('US', identity, id, NOW);
}

const reader = catalogReader(path);
const flagged = flags();
const server = matcherServer({ catalog: reader, market: 'US', flags: flagged, now: () => NOW });
let base = '';

function versionOf(file: string): string {
  return contentVersion(readFileSync(new URL(`../public/${file}`, import.meta.url)));
}

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

async function song(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/song?${query}`, { headers });
  return { res, body: await res.json() };
}

async function listen(options: Parameters<typeof matcherServer>[0]): Promise<string> {
  const other = matcherServer(options);
  await new Promise<void>((resolve) => other.listen(0, resolve));
  after(() => other.close());
  return `http://localhost:${(other.address() as AddressInfo).port}`;
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  reader.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
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

for (const page of ['/', '/privacy', '/terms', '/faq']) {
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
  assert.ok(html.includes(`<script src="/spotify-embed.js?v=${versionOf('spotify-embed.js')}"></script>`));
});

test('shares the page with an absolute preview image', async () => {
  const html = await (await fetch(`${base}/`)).text();

  assert.match(html, /<link rel="canonical" href="https:\/\/tempo-match\.hadalin\.me\/">/);
  const image = `https://tempo-match.hadalin.me/og-image.png?v=${versionOf('og-image.png')}`;
  assert.ok(html.includes(`<meta property="og:image" content="${image}">`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${image}">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

for (const path of ['/', '/privacy', '/terms', '/faq', '/app.js', '/theme.css', '/favicon.svg', '/og-image.png', '/robots.txt', '/sitemap.xml', '/api/song?bpm=120', '/missing']) {
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
    const res = await fetch(`${base}${path}`);

    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
}

for (const page of ['/', '/privacy', '/terms', '/faq']) {
  test(`makes caches revalidate ${page}`, async () => {
    const res = await fetch(`${base}${page}`);

    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
}

const ASSETS = [
  ['/app.js', 'app.js'],
  ['/spotify-embed.js', 'spotify-embed.js'],
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

test('lets crawlers in, keeps them off the API and points them to the sitemap', async () => {
  const res = await fetch(`${base}/robots.txt`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(
    await res.text(),
    'User-agent: *\nDisallow: /api/\n\nSitemap: https://tempo-match.hadalin.me/sitemap.xml\n',
  );
});

test('lists every page in the sitemap by its absolute URL', async () => {
  const res = await fetch(`${base}/sitemap.xml`);
  const xml = await res.text();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<\/urlset>\n$/);
  const urls = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><\/url>/g)].map(([, loc]) => loc);
  assert.deepEqual(urls.toSorted(), [
    'https://tempo-match.hadalin.me/',
    'https://tempo-match.hadalin.me/faq',
    'https://tempo-match.hadalin.me/privacy',
    'https://tempo-match.hadalin.me/terms',
  ]);
});

for (const path of ['/', '/faq', '/app.js', '/og-image.png', '/robots.txt', '/sitemap.xml', '/api/song?bpm=120', '/healthz', '/missing']) {
  test(`answers HEAD ${path} like GET without a body`, async () => {
    const get = await fetch(`${base}${path}`);
    const head = await fetch(`${base}${path}`, { method: 'HEAD' });

    assert.equal(head.status, get.status);
    for (const header of ['content-type', 'cache-control', 'content-security-policy']) {
      assert.equal(head.headers.get(header), get.headers.get(header), header);
    }
    assert.equal(await head.text(), '');
  });
}

function jsonLd(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(([, json]) => JSON.parse(json));
}

test('describes the home page as a free web application', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const description = html.match(/<meta name="description" content="([^"]+)">/)?.[1];

  assert.deepEqual(jsonLd(html), [{
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Tempo Match',
    url: 'https://tempo-match.hadalin.me/',
    description,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any',
    browserRequirements: 'Requires JavaScript',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  }]);
});

for (const page of ['/privacy', '/terms', '/faq']) {
  test(`leaves structured data off ${page}`, async () => {
    assert.deepEqual(jsonLd(await (await fetch(`${base}${page}`)).text()), []);
  });
}

for (const [path, title] of [['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/faq', 'FAQ']] as const) {
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

test('returns a stored song at the BPM with the listing title', async () => {
  const { res, body } = await song('bpm=120');

  assert.equal(res.status, 200);
  const match = SONGS.find((s) => s.id === body.spotifyTrackId);
  assert.deepEqual(body, { title: match?.title, artist: 'Artist', bpm: 120, spotifyTrackId: match?.id });
});

test('never serves the skipped song', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await song(`bpm=120&skip=${A}`)).body.spotifyTrackId, B);
  }
});

test('answers 503 with Retry-After at an empty BPM of 60-210, never another BPM', async () => {
  const { res, body } = await song(`bpm=120&skip=${A}&dead=${B}`);
  const empty = await song('bpm=121');

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.deepEqual(body, { error: 'No song at 120 BPM right now, try again in a minute' });
  assert.equal(empty.res.status, 503);
});

test('answers 404 at an empty BPM outside 60-210', async () => {
  const { res, body } = await song('bpm=41');

  assert.equal(res.status, 404);
  assert.deepEqual(body, { error: 'No song at 41 BPM yet' });
});

for (const country of ['US', 'SI', 'XX', 'T1', null]) {
  test(`serves the US picks to CF-IPCountry ${country}`, async () => {
    const headers: Record<string, string> = country === null ? {} : { 'CF-IPCountry': country };

    assert.equal((await song(`bpm=97`, headers)).body.spotifyTrackId, LUCKY);
  });
}

for (const [bpm, status] of [
  ['abc', 400],
  ['39', 400],
  ['221', 400],
  ['120.0', 400],
  ['0x78', 400],
  ['1e2', 400],
  ['%2B120', 400],
  ['%20120', 400],
] as const) {
  test(`maps bpm=${bpm} to HTTP ${status}`, async () => {
    const { res, body } = await song(`bpm=${bpm}`);

    assert.equal(res.status, status);
    assert.equal(typeof body.error, 'string');
  });
}

for (const target of ['//', '//[']) {
  test(`answers request target ${target} with 404 and keeps serving`, async () => {
    assert.equal(await rawStatusLine(target), 'HTTP/1.1 404 Not Found');
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
}

test('three IP prefixes in the market flagging a pick make it a suspect', async () => {
  for (const ip of ['192.0.2.1', '192.0.2.2', '198.51.100.1', '2001:db8:1::1']) {
    const { body } = await song(`bpm=120&dead=${A}`, { 'CF-IPCountry': 'US', 'CF-Connecting-IP': ip });
    assert.equal(body.spotifyTrackId, B);
  }

  assert.deepEqual(flagged.suspects(NOW), [A]);
});

test('a flag from another country never makes a suspect', async () => {
  for (const ip of ['203.0.113.1', '203.0.114.1', '203.0.115.1']) {
    await song(`bpm=97&dead=${LUCKY}`, { 'CF-IPCountry': 'SI', 'CF-Connecting-IP': ip });
  }

  assert.ok(!flagged.suspects(NOW).includes(LUCKY));
});

test('ignores a dead id that is malformed or not a pick', async () => {
  const notPick = 'Z'.repeat(22);
  for (const ip of ['203.0.113.1', '203.0.114.1', '203.0.115.1']) {
    await song(`bpm=120&dead=short`, { 'CF-IPCountry': 'US', 'CF-Connecting-IP': ip });
    await song(`bpm=120&dead=${notPick}`, { 'CF-IPCountry': 'US', 'CF-Connecting-IP': ip });
  }

  assert.ok(!flagged.suspects(NOW).includes(notPick));
});

test('a lucky request returns a pick at another BPM', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await song('lucky=1&exclude=120')).body.spotifyTrackId, LUCKY);
  }
});

test('a lucky request ignores bpm, skips the given song and answers 404 when nothing is left', async () => {
  const { res, body } = await song(`lucky=1&bpm=120&exclude=120&skip=${LUCKY}`);

  assert.equal(res.status, 404);
  assert.deepEqual(body, { error: 'No song found, try again later' });
});

for (const exclude of ['', 'abc', '120.5', '39', '221', '1e2', '0x78']) {
  test(`a lucky request ignores an invalid exclude of "${exclude}"`, async () => {
    const { res } = await song(`lucky=1&exclude=${exclude}&skip=${LUCKY}`);

    assert.equal(res.status, 200);
  });
}

test('treats a lucky value other than 1 as a normal search', async () => {
  assert.equal((await song('lucky=yes')).res.status, 400);
});

test('reports picks and the oldest pick age on /healthz', async () => {
  const res = await fetch(`${base}/healthz`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { market: 'US', picks: 3, oldestPickDays: 0 });
});

test('answers 503 while the catalog does not exist yet', async (t) => {
  const missing = catalogReader(join(dir, 'missing.db'));
  t.mock.method(console, 'error', () => {});
  const other = await listen({ catalog: missing, market: 'US', flags: flags() });
  t.after(() => missing.close());

  const api = await fetch(`${other}/api/song?bpm=120`);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { error: 'Warming up, try again in a minute' });
  assert.equal((await fetch(`${other}/healthz`)).status, 503);
  assert.equal((await fetch(`${other}/`)).status, 200);
});

test('answers 503 with a short Retry-After while the database is busy', async () => {
  const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
  const queries = { songAt: () => { throw busy; }, lucky: () => null, isPick: () => false, summary: () => ({ picks: 0, oldestLookedUpAt: null }) };
  const catalog: CatalogReader = { queries: () => queries, close() {} };
  const other = await listen({ catalog, market: 'US', flags: flags() });

  const res = await fetch(`${other}/api/song?bpm=120`);

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '1');
});

test('depends only on the catalog, so it cannot import an upstream client', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(manifest.dependencies, { '@tempo-match/catalog': '*' });
});
