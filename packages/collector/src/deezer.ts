import { CallKind, type Dispatcher } from './dispatcher.ts';
import { UnavailableError } from './errors.ts';
import type { SourceSong } from './source.ts';
import { request } from './upstream.ts';

const SEARCH_URL = 'https://api.deezer.com/search/track';
const SERVICE = 'Deezer';
export const DEEZER_PAGE_SIZE = 100;
// One BPM query returns about 300 rows, whatever the seed.
export const DEEZER_MAX_INDEX = 200;

// Deezer's tempo analysis has almost no tracks below 60 or above 210 BPM.
export const DEEZER_MIN_BPM = 60;
export const DEEZER_MAX_BPM = 210;

/**
 * Deezer's popularity score. Hits rank near 1,000,000, while seeded queries also surface tracks
 * ranked in the hundreds that are unlikely to be on Spotify or known to anyone.
 */
const MIN_RANK = 10_000;
const TOP_RANK = 1_000_000;

// Each seed selects a different slice of the rows one BPM query returns.
// Deezer returns nothing when artist: is combined with another field, so seeds avoid it.
export const DEEZER_SEEDS = [
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
  duration?: number;
  artist?: { name?: string };
}

interface SearchPage {
  data?: SearchTrack[];
  error?: unknown;
}

export interface DeezerPage {
  songs: SourceSong[];
  /** Rows Deezer returned before filtering; fewer than a page means the slice ends here. */
  rows: number;
}

export function deezer(
  calls: Dispatcher,
  fetchFn: typeof fetch = fetch,
): (bpm: number, seed: string, index: number) => Promise<DeezerPage> {
  return (bpm, seed, index) =>
    calls.call(CallKind.Plain, async () => {
      const url = new URL(SEARCH_URL);
      // Deezer ignores unquoted bpm_min/bpm_max values; quoted ones match floor(bpm) == N.
      url.searchParams.set('q', `${seed} bpm_min:"${bpm}" bpm_max:"${bpm}"`.trim());
      url.searchParams.set('limit', String(DEEZER_PAGE_SIZE));
      url.searchParams.set('index', String(index));
      const res = await request(SERVICE, fetchFn, url);

      // Deezer reports API errors such as quota exhaustion with HTTP 200 and an error object.
      const body = (await res.json()) as SearchPage;
      if (body.error) {
        throw new UnavailableError(SERVICE, JSON.stringify(body.error));
      }
      const data = body.data ?? [];
      return { songs: data.flatMap((track) => toSourceSong(track, bpm)), rows: data.length };
    });
}

function toSourceSong(track: SearchTrack, bpm: number): SourceSong[] {
  const artist = track.artist?.name;
  const rank = track.rank ?? 0;
  if (!track.title || !artist || rank < MIN_RANK) {
    return [];
  }

  // Search rows carry no bpm today; the bpm filter already guarantees floor(bpm) == bpm.
  if (track.bpm && Math.floor(track.bpm) !== bpm) {
    return [];
  }
  return [
    {
      title: track.title,
      artist,
      popularity: Math.min(rank / TOP_RANK, 1),
      ...(track.isrc && { isrc: track.isrc }),
      ...(typeof track.duration === 'number' && track.duration > 0 && { durationS: track.duration }),
    },
  ];
}
