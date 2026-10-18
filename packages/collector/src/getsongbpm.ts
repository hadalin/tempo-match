import { CallKind, type Dispatcher } from './dispatcher.ts';
import type { SourceSong } from './source.ts';
import { request } from './upstream.ts';

const TEMPO_URL = 'https://api.getsong.co/tempo/';
const SERVICE = 'GetSongBPM';
// The documented default is 250 songs; whether a larger limit returns more shows in the first pass.
const PAGE_LIMIT = 1000;

interface TempoEntry {
  song_title?: string;
  tempo?: string | number;
  artist?: { name?: string };
}

/** The songs GetSongBPM lists at exactly `bpm`, most viewed first. */
export function getSongBpm(
  apiKey: string,
  calls: Dispatcher,
  fetchFn: typeof fetch = fetch,
): (bpm: number) => Promise<SourceSong[]> {
  return (bpm) =>
    calls.call(CallKind.Plain, async () => {
      const url = new URL(TEMPO_URL);
      url.searchParams.set('bpm', String(bpm));
      url.searchParams.set('limit', String(PAGE_LIMIT));
      const res = await request(SERVICE, fetchFn, url, { headers: { 'X-API-KEY': apiKey } });

      // GetSongBPM signals "no songs" with a non-array payload such as an error object.
      const body = (await res.json()) as { tempo?: unknown };
      if (!Array.isArray(body.tempo)) {
        return [];
      }
      const entries = body.tempo as TempoEntry[];
      return entries.flatMap((entry, i) => toSourceSong(entry, bpm, 1 - i / entries.length));
    });
}

function toSourceSong(entry: TempoEntry, bpm: number, popularity: number): SourceSong[] {
  const artist = entry.artist?.name;
  if (!entry.song_title || !artist || Number(entry.tempo) !== bpm) {
    return [];
  }
  return [{ title: entry.song_title, artist, popularity }];
}
