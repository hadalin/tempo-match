import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ttlCache } from '../src/cache.ts';

test('evicts the oldest entry beyond the size bound', async () => {
  const loads: string[] = [];
  const cached = ttlCache<string>(1000, 2, () => 0);
  const load = (key: string) => () => {
    loads.push(key);
    return Promise.resolve(key);
  };

  for (const key of ['a', 'b', 'c', 'b', 'a']) {
    await cached(key, load(key));
  }

  assert.deepEqual(loads, ['a', 'b', 'c', 'a']);
});
