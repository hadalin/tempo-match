import { InvalidBpmError, LuckyDisabledError, NoLuckyPickError, NoMatchError } from './errors.ts';
import { normalize } from './normalize.ts';
import type { SongProvider, TempoSong } from './provider.ts';
import { PAGE_LIMIT, type CatalogTrack, type TrackCatalog } from './spotify.ts';
import type { TempoVerifier, TrackFeatures } from './verifier.ts';

export const MIN_BPM = 40;
export const MAX_BPM = 220;

const MAX_CANDIDATES = 5;
const TEMPO_TOLERANCE_BPM = 3;
// Spotify documents tracks at or above this speechiness as probably all spoken words.
const SPOKEN_WORD_SPEECHINESS = 0.66;
const UNVERIFIED: TrackFeatures = { tempo: null, speechiness: null };

const MAX_LUCKY_SEARCHES = 3;
const MIN_LUCKY_POPULARITY = 50;
// Deeper pages rank lower and are mostly obscure tracks below the popularity floor.
const MAX_LUCKY_OFFSET = 200;
// Offsets start whole pages, so overlapping windows of the same rows are not cached separately.
const LUCKY_PAGES = MAX_LUCKY_OFFSET / PAGE_LIMIT + 1;
// Common title words, so each search returns a full page of widely known tracks.
const LUCKY_TERMS = [
  'a', 'love', 'night', 'you', 'the', 'me', 'baby', 'heart', 'time', 'day',
  'girl', 'dance', 'life', 'summer', 'fire', 'home', 'world', 'dream', 'light', 'sun',
];

export interface MatchedSong {
  title: string;
  artist: string;
  bpm: number;
  spotifyTrackId: string;
}

export interface TempoEngine {
  matchSong(bpm: number, market?: string): Promise<MatchedSong>;
  /**
   * A random popular track, with bpm set to its tempo rounded to a whole number.
   * Tracks whose rounded tempo equals excludeBpm are skipped.
   */
  luckySong(market?: string, excludeBpm?: number): Promise<MatchedSong>;
}

export function createEngine(
  providers: SongProvider[],
  catalog: TrackCatalog,
  random: () => number = Math.random,
  verifier?: TempoVerifier,
): TempoEngine {
  return {
    async matchSong(bpm, market) {
      if (!Number.isInteger(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
        throw new InvalidBpmError(bpm, MIN_BPM, MAX_BPM);
      }

      const songs = await songsAt(providers, bpm);
      const candidates = shuffle(songs, random).slice(0, MAX_CANDIDATES);

      for (const song of candidates) {
        const spotifyTrackId = await catalog.findTrackId(song, market);
        if (!spotifyTrackId) {
          continue;
        }

        if (verifier && !(await verified(verifier, spotifyTrackId, bpm))) {
          continue;
        }
        return { title: song.title, artist: song.artist, bpm: song.bpm, spotifyTrackId };
      }
      throw new NoMatchError(bpm);
    },

    async luckySong(market, excludeBpm) {
      if (!verifier) {
        throw new LuckyDisabledError();
      }

      for (let search = 0; search < MAX_LUCKY_SEARCHES; search++) {
        const term = LUCKY_TERMS[Math.floor(random() * LUCKY_TERMS.length)];
        const offset = Math.floor(random() * LUCKY_PAGES) * PAGE_LIMIT;
        const tracks = await catalog.searchTracks(term, offset, market);
        const song = await pickLucky(tracks, verifier, random, excludeBpm);
        if (song) {
          return song;
        }
      }
      throw new NoLuckyPickError();
    },
  };
}

async function pickLucky(
  tracks: CatalogTrack[],
  verifier: TempoVerifier,
  random: () => number,
  excludeBpm: number | undefined,
): Promise<MatchedSong | null> {
  const popularity = await verifier.popularityOf(tracks.map((t) => t.spotifyTrackId));
  const popular = tracks.filter((_, i) => (popularity[i] ?? 0) >= MIN_LUCKY_POPULARITY);
  if (popular.length === 0) {
    return null;
  }

  const candidates = shuffle(popular, random);
  const features = await verifier.featuresOfAll(candidates.map((t) => t.spotifyTrackId));
  for (const [i, track] of candidates.entries()) {
    const { tempo, speechiness } = features[i];
    if (tempo === null || isSpoken(speechiness)) {
      continue;
    }

    const bpm = Math.round(tempo);
    if (bpm >= MIN_BPM && bpm <= MAX_BPM && bpm !== excludeBpm) {
      return { ...track, bpm };
    }
  }
  return null;
}

async function verified(
  verifier: TempoVerifier,
  spotifyTrackId: string,
  bpm: number,
): Promise<boolean> {
  const { tempo, speechiness } = await verifier
    .featuresOf(spotifyTrackId)
    .catch(() => UNVERIFIED);
  const tempoAgrees = tempo === null || Math.abs(tempo - bpm) <= TEMPO_TOLERANCE_BPM;
  return tempoAgrees && !isSpoken(speechiness);
}

function isSpoken(speechiness: number | null): boolean {
  return speechiness !== null && speechiness >= SPOKEN_WORD_SPEECHINESS;
}

async function songsAt(providers: SongProvider[], bpm: number): Promise<TempoSong[]> {
  const results = await Promise.allSettled(providers.map((provider) => provider.songsAt(bpm)));
  const listed = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const songs = dedupe(listed.filter((song) => song.bpm === bpm));

  const failure = results.find((r) => r.status === 'rejected');
  if (songs.length === 0 && failure) {
    throw failure.reason;
  }
  return songs;
}

function dedupe(songs: TempoSong[]): TempoSong[] {
  const kept: { song: TempoSong; name: string }[] = [];
  for (const song of songs) {
    const name = JSON.stringify([normalize(song.title), normalize(song.artist)]);
    const duplicate = kept.find((k) =>
      k.song.isrc && song.isrc ? k.song.isrc === song.isrc : k.name === name,
    );
    if (!duplicate) {
      kept.push({ song, name });
      continue;
    }

    if (!duplicate.song.isrc && song.isrc) {
      duplicate.song = { ...duplicate.song, isrc: song.isrc };
    }
  }
  return kept.map((k) => k.song);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
