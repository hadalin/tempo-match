import { DAY_MS, ttlCache } from './cache.ts';
import { UpstreamError } from './errors.ts';
import type { SongProvider, TempoSong } from './provider.ts';
import { fetchUpstream } from './upstream.ts';

const TEMPO_URL = 'https://api.getsong.co/tempo/';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CACHED_TEMPOS = 256;

interface TempoEntry {
  song_title?: string;
  tempo?: string | number;
  artist?: { name?: string };
}

export function getSongBpm(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): SongProvider {
  const cached = ttlCache<TempoSong[]>(DAY_MS, MAX_CACHED_TEMPOS, now);

  async function fetchSongs(bpm: number): Promise<TempoSong[]> {
    const url = new URL(TEMPO_URL);
    url.searchParams.set('bpm', String(bpm));

    const res = await fetchUpstream('GetSongBPM', fetchFn, url, {
      headers: { 'X-API-KEY': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new UpstreamError('GetSongBPM', res.status);
    }

    // GetSongBPM signals "no songs" with a non-array payload such as an error object.
    const body = (await res.json()) as { tempo?: unknown };
    if (!Array.isArray(body.tempo)) {
      return [];
    }
    return body.tempo.flatMap(toTempoSong);
  }

  return {
    songsAt: (bpm) => cached(String(bpm), () => fetchSongs(bpm)),
  };
}

function toTempoSong(entry: TempoEntry): TempoSong[] {
  const bpm = Number(entry.tempo);
  const artist = entry.artist?.name;
  if (!entry.song_title || !artist || !Number.isFinite(bpm)) {
    return [];
  }
  return [{ title: entry.song_title, artist, bpm }];
}
