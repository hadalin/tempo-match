import { DAY_MS, ttlCache } from './cache.ts';
import { UpstreamError } from './errors.ts';
import type { SongProvider, TempoSong } from './provider.ts';
import { fetchUpstream } from './upstream.ts';

const SEARCH_URL = 'https://api.deezer.com/search/track';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CACHED_SLICES = 1024;
const PAGE_SIZE = 100;
const MAX_START_INDEX = 100;
const MAX_CALLS = 3;
const ENOUGH_SONGS = 50;

// Deezer's tempo analysis has almost no tracks below 60 or above 210 BPM.
const MIN_COVERED_BPM = 60;
const MAX_COVERED_BPM = 210;

/**
 * Deezer's popularity score. Hits rank near 1,000,000, while seeded queries also surface tracks
 * ranked in the hundreds that are unlikely to be on Spotify or known to anyone.
 */
const MIN_RANK = 10_000;

// Each seed selects a different slice of the roughly 300 rows one BPM query returns.
// Deezer returns nothing when artist: is combined with another field, so seeds avoid it.
const SEEDS = [
  '',
  'track:"a"',
  'track:"e"',
  'track:"o"',
  'track:"i"',
  'track:"love"',
  'track:"night"',
  'track:"you"',
  'album:"a"',
  'album:"love"',
  'album:"live"',
  'label:"a"',
  'label:"records"',
];

interface SearchTrack {
  title?: string;
  isrc?: string;
  rank?: number;
  bpm?: number;
  artist?: { name?: string };
}

interface SearchPage {
  data?: SearchTrack[];
  total?: number;
  error?: unknown;
}

interface CallBudget {
  left: number;
}

export function deezer(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  random: () => number = Math.random,
): SongProvider {
  const cached = ttlCache<TempoSong[]>(DAY_MS, MAX_CACHED_SLICES, now);

  async function fetchPage(bpm: number, seed: string, index: number): Promise<SearchPage> {
    const url = new URL(SEARCH_URL);
    // Deezer ignores unquoted bpm_min/bpm_max values; quoted ones match floor(bpm) == N.
    url.searchParams.set('q', `${seed} bpm_min:"${bpm}" bpm_max:"${bpm}"`.trim());
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('index', String(index));

    const res = await fetchUpstream('Deezer', fetchFn, url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = res.ok ? ((await res.json()) as SearchPage) : null;
    // Deezer reports API errors such as quota exhaustion with HTTP 200 and an error object.
    if (!body || body.error) {
      throw new UpstreamError('Deezer', res.status);
    }
    return body;
  }

  async function fetchSlice(bpm: number, seed: string, budget: CallBudget): Promise<TempoSong[]> {
    // The last request cannot reread a page, so it reads the one page every non-empty slice has.
    const index = budget.left > 1 ? Math.floor(random() * (MAX_START_INDEX + 1)) : 0;
    budget.left--;
    let page = await fetchPage(bpm, seed, index);

    const total = page.total ?? 0;
    if (index >= total && total > 0 && budget.left > 0) {
      budget.left--;
      page = await fetchPage(bpm, seed, Math.max(0, total - PAGE_SIZE));
    }
    return (page.data ?? []).flatMap((track) => toTempoSong(track, bpm));
  }

  return {
    async songsAt(requested) {
      const bpm = Math.floor(requested);
      if (bpm < MIN_COVERED_BPM || bpm > MAX_COVERED_BPM) {
        return [];
      }

      const budget = { left: MAX_CALLS };
      const seeds = [...SEEDS];
      const songs: TempoSong[] = [];
      while (budget.left > 0 && seeds.length > 0 && songs.length < ENOUGH_SONGS) {
        const [seed] = seeds.splice(Math.floor(random() * seeds.length), 1);
        const key = JSON.stringify([bpm, seed]);
        songs.push(...(await cached(key, () => fetchSlice(bpm, seed, budget))));
      }
      return songs;
    },
  };
}

function toTempoSong(track: SearchTrack, bpm: number): TempoSong[] {
  const artist = track.artist?.name;
  if (!track.title || !artist || (track.rank ?? 0) < MIN_RANK) {
    return [];
  }

  // Search rows carry no bpm today; the bpm filter already guarantees floor(bpm) == bpm.
  if (track.bpm && Math.floor(track.bpm) !== bpm) {
    return [];
  }
  return [{ title: track.title, artist, bpm, ...(track.isrc && { isrc: track.isrc }) }];
}
