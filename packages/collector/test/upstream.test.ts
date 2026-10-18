import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deezer, getSongBpm, reccoBeats, spotify, UpstreamError } from '../src/index.ts';

const CREDENTIALS = { clientId: 'id', clientSecret: 'secret', market: 'US' };

const FAILURES = [
  ['is unreachable', new TypeError('fetch failed')],
  ['times out', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
] as const;

const LOOKUPS = [
  ['GetSongBPM', (fetch: typeof globalThis.fetch) => getSongBpm('key', fetch).songsAt(120)],
  ['Deezer', (fetch: typeof globalThis.fetch) => deezer(fetch).songsAt(120)],
  ['Spotify', (fetch: typeof globalThis.fetch) => spotify(CREDENTIALS, fetch).searchTracks('a', 0)],
  ['ReccoBeats', (fetch: typeof globalThis.fetch) => reccoBeats(fetch).featuresOf('a')],
] as const;

for (const [service, lookup] of LOOKUPS) {
  for (const [label, failure] of FAILURES) {
    test(`throws UpstreamError when ${service} ${label}`, async () => {
      const fetch = (async () => {
        throw failure;
      }) as typeof globalThis.fetch;

      await assert.rejects(lookup(fetch), (err) => err instanceof UpstreamError && err.cause === failure);
    });
  }
}
