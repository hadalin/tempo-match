import type { DatabaseSync } from 'node:sqlite';
import { identityOf, MAX_BPM, MIN_BPM, type Listing, type Transitions } from '@tempo-match/catalog';
import type { Clock } from './clock.ts';
import { retriesLater } from './errors.ts';
import type { SourceSong } from './source.ts';
import { isNonSong } from './title-filter.ts';

const FIRST_BPMS = { from: 80, to: 140 };

export interface CrawlItem {
  bpm: number;
  seed: string;
}

export interface CrawlPage {
  songs: SourceSong[];
  /** The index of the next page of this item, or null when the item is done for this pass. */
  next: number | null;
}

export interface CrawlSource {
  name: string;
  /** The catalog's bit for this source in songs.sources. */
  bit: number;
  /** Time from finishing an item to crawling it again. */
  periodMs: number;
  items: CrawlItem[];
  page(item: CrawlItem, index: number): Promise<CrawlPage>;
}

export interface Crawler {
  /** Crawls the next page that is due; false when nothing is due. */
  step(): Promise<boolean>;
}

interface State {
  bpm: number;
  seed: string;
  next_index: number;
  done_at: number | null;
}

/** 40-220 BPM, the most common tempos first. */
export function crawlOrder(min = MIN_BPM, max = MAX_BPM): number[] {
  const all = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const first = all.filter((bpm) => bpm >= FIRST_BPMS.from && bpm <= FIRST_BPMS.to);
  return [...first, ...all.filter((bpm) => !first.includes(bpm))];
}

export function crawler(db: DatabaseSync, t: Transitions, source: CrawlSource, clock: Clock): Crawler {
  const states = db.prepare('SELECT bpm, seed, next_index, done_at FROM crawl_state WHERE source = ?');
  const save = db.prepare(`
    INSERT INTO crawl_state (source, bpm, seed, next_index, done_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source, bpm, seed) DO UPDATE SET next_index = excluded.next_index, done_at = excluded.done_at
  `);
  const key = (item: CrawlItem) => JSON.stringify([item.bpm, item.seed]);

  function listing(song: SourceSong, bpm: number): Listing {
    return { ...song, identity: identityOf(song.title, song.artist), bpm, source: source.bit };
  }

  async function fetchPage(item: CrawlItem, index: number): Promise<CrawlPage> {
    try {
      return await source.page(item, index);
    } catch (err) {
      if (retriesLater(err)) {
        throw err;
      }
      // Asking again would fail the same way, so the item waits for the next pass.
      console.error(`${source.name} ${item.bpm} BPM ${item.seed || 'unseeded'} skipped:`, err);
      return { songs: [], next: null };
    }
  }

  return {
    async step() {
      const now = clock.now();
      const known = new Map((states.all(source.name) as unknown as State[]).map((s) => [key(s), s]));
      const due = (item: CrawlItem) => {
        const state = known.get(key(item));
        return !state || state.next_index > 0 || state.done_at === null || state.done_at <= now - source.periodMs;
      };
      const item = source.items.find(due);
      if (!item) {
        return false;
      }

      const state = known.get(key(item));
      const index = state?.next_index ?? 0;
      const page = await fetchPage(item, index);
      const songs = page.songs.filter((song) => !isNonSong(song.title));
      t.upsertListings(songs.map((song) => listing(song, item.bpm)), clock.now());

      if (page.next !== null) {
        save.run(source.name, item.bpm, item.seed, page.next, state?.done_at ?? null);
        return true;
      }
      save.run(source.name, item.bpm, item.seed, 0, clock.now());

      const pending = source.items.filter((other) => other !== item && due(other));
      if (!pending.some((other) => other.bpm === item.bpm)) {
        console.log(`${source.name}: ${item.bpm} BPM done`);
      }
      if (pending.length === 0) {
        console.log(`${source.name}: pass complete`);
      }
      return true;
    },
  };
}
