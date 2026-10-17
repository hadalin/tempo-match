import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { TempoEngine } from '@tempo-match/engine';
import { fixedWindow, InvalidRateLimitError, parseRateLimit } from '../src/rate-limit.ts';
import { webServer } from '../src/server.ts';

const SONG = { title: 'Song', artist: 'Artist', bpm: 120, spotifyTrackId: '1' };

const engine: TempoEngine = {
  async matchSong() {
    return SONG;
  },
  async luckySong() {
    return SONG;
  },
};

let now = 0;
const server = webServer(engine, fixedWindow({ count: 2, windowSeconds: 10 }, () => now));
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('parses <count>/<seconds>', () => {
  assert.deepEqual(parseRateLimit('10/10'), { count: 10, windowSeconds: 10 });
});

const OVERFLOWING = [`${'9'.repeat(309)}/20`, `1/${'9'.repeat(309)}`, '9007199254740993/10', '1/9007199254741'];

for (const spec of ['10', '10/', '/10', '0/10', '10/0', 'a/b', '10/10/10', ' 10/10', '-1/10', '1.5/10', ...OVERFLOWING]) {
  test(`rejects SIMULATE_RATE_LIMIT=${spec}`, () => {
    assert.throws(() => parseRateLimit(spec), InvalidRateLimitError);
  });
}

test('answers 429 past the count until the window ends', async () => {
  now = 0;
  assert.equal((await fetch(`${base}/api/song?bpm=120`)).status, 200);
  now = 1_000;
  assert.equal((await fetch(`${base}/api/song?bpm=120`)).status, 200);

  now = 2_500;
  const limited = await fetch(`${base}/api/song?bpm=120`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '8');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.match(limited.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await limited.text(), /Too many requests/);

  now = 10_000;
  const allowed = await fetch(`${base}/api/song?bpm=120`);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), SONG);
});

test('does not limit the page', async () => {
  now = 20_000;
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/api/song?bpm=120`);
  }

  assert.equal((await fetch(`${base}/`)).status, 200);
});
