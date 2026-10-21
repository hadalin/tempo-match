import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectorConfig, type Env } from '../src/config.ts';
import { InvalidConfigError } from '../src/errors.ts';

const KEYS: Env = { GETSONGBPM_API_KEY: 'key', SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' };

test('Spotify daily calls default to 1000 when unset or empty', () => {
  assert.equal(collectorConfig(KEYS).spotifyDailyCalls, 1_000);
  assert.equal(collectorConfig({ ...KEYS, SPOTIFY_DAILY_CALLS: '' }).spotifyDailyCalls, 1_000);
});

test('Spotify daily calls come from SPOTIFY_DAILY_CALLS', () => {
  assert.equal(collectorConfig({ ...KEYS, SPOTIFY_DAILY_CALLS: '2000' }).spotifyDailyCalls, 2_000);
});

test('an invalid SPOTIFY_DAILY_CALLS is rejected', () => {
  for (const value of ['0', '-5', '1.5', 'abc', '1e3']) {
    assert.throws(() => collectorConfig({ ...KEYS, SPOTIFY_DAILY_CALLS: value }), InvalidConfigError, value);
  }
});
