import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DAY_MS, identityOf, SOURCE_DEEZER } from '@tempo-match/catalog';
import { crawler, crawlOrder, type CrawlItem, type CrawlPage, type CrawlSource } from '../src/crawl.ts';
import { RefusedError, UpstreamError } from '../src/errors.ts';
import { memoryCatalog } from './catalog.ts';
import { fakeClock } from './fake-clock.ts';

const PERIOD = 7 * DAY_MS;

function setup(page: (item: CrawlItem, index: number) => Promise<CrawlPage>, items: CrawlItem[]) {
  const { db, t } = memoryCatalog();
  const clock = fakeClock();
  const asked: [number, string, number][] = [];
  const source: CrawlSource = {
    name: 'deezer',
    bit: SOURCE_DEEZER,
    periodMs: PERIOD,
    items,
    page: (item, index) => {
      asked.push([item.bpm, item.seed, index]);
      return page(item, index);
    },
  };
  mock.method(console, 'log', () => {});
  return { db, clock, asked, crawl: () => crawler(db, t, source, clock) };
}

const song = (title: string) => ({ title, artist: 'Artist', popularity: 0.5 });

test('crawls 80-140 BPM first, then the rest of 40-220', () => {
  const order = crawlOrder();

  assert.deepEqual(order.slice(0, 3), [80, 81, 82]);
  assert.equal(order[60], 140);
  assert.deepEqual(order.slice(61, 63), [40, 41]);
  assert.equal(order.length, 181);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 181 }, (_, i) => 40 + i));
});

test('reads every page of an item, then the next item, and stores the songs', async () => {
  const pages = (_: CrawlItem, index: number) => Promise.resolve({ songs: [song(`S${index}`)], next: index < 200 ? index + 100 : null });
  const { db, asked, crawl } = setup(pages, [{ bpm: 120, seed: '' }, { bpm: 121, seed: '' }]);
  const step = crawl().step;

  while (await step()) {}

  assert.deepEqual(asked, [[120, '', 0], [120, '', 100], [120, '', 200], [121, '', 0], [121, '', 100], [121, '', 200]]);
  const stored = db.prepare('SELECT identity, bpm, sources FROM songs ORDER BY bpm, identity').all().map((r) => ({ ...r }));
  assert.equal(stored.length, 6);
  assert.deepEqual(stored[0], { identity: identityOf('S0', 'Artist'), bpm: 120, sources: SOURCE_DEEZER });
});

test('drops non-song titles before storing them', async () => {
  const { db, crawl } = setup(() => Promise.resolve({ songs: [song('Halo (Backing Track)'), song('Halo')], next: null }), [{ bpm: 120, seed: '' }]);

  await crawl().step();

  assert.deepEqual(db.prepare('SELECT title FROM songs').all().map((r) => r.title), ['Halo']);
});

test('resumes after a restart at the page where it stopped', async () => {
  let fail = false;
  const pages = (_: CrawlItem, index: number) =>
    fail && index === 100 ? Promise.reject(new RefusedError('Deezer', 0, 'banned')) : Promise.resolve({ songs: [], next: index < 200 ? index + 100 : null });
  const { asked, crawl } = setup(pages, [{ bpm: 120, seed: '' }]);
  await crawl().step();
  fail = true;
  await assert.rejects(crawl().step(), RefusedError);
  fail = false;

  await crawl().step();

  assert.deepEqual(asked, [[120, '', 0], [120, '', 100], [120, '', 100]]);
});

test('crawls an item again only after its period', async () => {
  const { clock, asked, crawl } = setup(() => Promise.resolve({ songs: [], next: null }), [{ bpm: 120, seed: '' }]);
  const { step } = crawl();
  await step();

  assert.equal(await step(), false);
  clock.advance(PERIOD);
  assert.equal(await step(), true);
  assert.equal(asked.length, 2);
});

test('skips an item until the next pass when its request would fail the same way again', async () => {
  const { asked, crawl } = setup(() => Promise.reject(new UpstreamError('Deezer', 400)), [{ bpm: 120, seed: '' }, { bpm: 121, seed: '' }]);
  mock.method(console, 'error', () => {});
  const { step } = crawl();

  while (await step()) {}

  assert.deepEqual(asked.map(([bpm]) => bpm), [120, 121]);
});
