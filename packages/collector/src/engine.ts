import {
  BusyError,
  InvalidBpmError,
  LuckyDisabledError,
  NoLuckyPickError,
  NoMatchError,
} from './errors.ts';
import { normalize, normalizeTitle } from '@tempo-match/catalog';
import type { SongProvider, TempoSong } from './provider.ts';
import { PAGE_LIMIT, type CatalogTrack, type TrackCatalog } from './spotify.ts';
import { memorySongStore, type Rejection, type Resolution, type SongStore } from './store.ts';
import type { TempoVerifier, TrackFeatures } from './verifier.ts';

export const MIN_BPM = 40;
export const MAX_BPM = 220;

const MAX_CANDIDATES = 5;
const TEMPO_TOLERANCE_BPM = 3;
// Spotify documents tracks at or above this speechiness as probably all spoken words.
const SPOKEN_WORD_SPEECHINESS = 0.66;
const NOT_FOUND = {
  outcome: 'not-found',
  spotifyTrackId: null,
  tempo: null,
  speechiness: null,
  rejection: null,
} as const;
// Karaoke, backing tracks, skits, interviews and audiobook chapters that the duration and
// speechiness checks let through. Opera titles such as "Act 2, Scene 12" must still pass.
const NON_SONG_TITLE = new RegExp(
  [
    String.raw`\b(skits?|interview|commentary|karaoke|(performance|backing) track|made famous by|originally performed by|sound-a-like|in the style of)\b`,
    String.raw`\b(kapitel|chapter|cap[ií]tulo|chapitre|capitolo|hoofdstuk|kapittel|rozdział)\s*\d+`,
    String.raw`^scene\s*\d+\b`,
    String.raw`[([]\s*instrumental(\s+version)?\s*[)\]]`,
  ].join('|'),
  'iu',
);

const MAX_LUCKY_SEARCHES = 3;
const MIN_LUCKY_POPULARITY = 50;
const LUCKY_SAMPLE = 20;
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
  store: SongStore = memorySongStore(),
): TempoEngine {
  /** The Spotify track id of a song that is on Spotify and passes the checks, or null. */
  async function resolve(song: TempoSong, bpm: number, market?: string): Promise<string | null> {
    const where = market ?? catalog.market;
    const identity = identityOf(song);
    const stored = store.get(where, identity);
    if (stored) {
      return acceptedId(stored, bpm);
    }

    const { title, artist } = song;
    const spotifyTrackId = await catalog.findTrackId(song, market);
    if (!spotifyTrackId) {
      store.put(where, identity, { ...NOT_FOUND, title, artist });
      return null;
    }

    // Without ReccoBeats data the song passes unverified, as before, but is not stored.
    const features = await verifier?.featuresOf(spotifyTrackId).catch(() => undefined);
    if (!features) {
      return spotifyTrackId;
    }

    const rejection = rejectionOf(features, bpm);
    const outcome = rejection ? 'rejected' : 'found';
    store.put(where, identity, { outcome, title, artist, spotifyTrackId, ...features, rejection });
    return rejection ? null : spotifyTrackId;
  }

  function storedLucky(market: string, excludeBpm: number | undefined): MatchedSong | null {
    const stored = store.sample(market, LUCKY_SAMPLE);
    for (const { title, artist, spotifyTrackId, ...features } of stored) {
      const bpm = luckyBpm(features, excludeBpm);
      if (bpm !== null && spotifyTrackId) {
        return { title, artist, bpm, spotifyTrackId };
      }
    }
    return null;
  }

  async function searchLucky(
    verifier: TempoVerifier,
    market: string | undefined,
    excludeBpm: number | undefined,
  ): Promise<MatchedSong> {
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
  }

  return {
    async matchSong(bpm, market) {
      if (!Number.isInteger(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
        throw new InvalidBpmError(bpm, MIN_BPM, MAX_BPM);
      }

      const songs = shuffle(await songsAt(providers, bpm), random);
      let busy: BusyError | undefined;
      for (const song of songs.slice(0, MAX_CANDIDATES)) {
        try {
          const spotifyTrackId = await resolve(song, bpm, market);
          if (spotifyTrackId) {
            return { title: song.title, artist: song.artist, bpm: song.bpm, spotifyTrackId };
          }
        } catch (err) {
          if (!(err instanceof BusyError)) {
            throw err;
          }
          busy = err;
        }
      }
      if (!busy) {
        throw new NoMatchError(bpm);
      }

      // Spotify refuses calls for now, so settle for any listed song the store knows.
      const where = market ?? catalog.market;
      for (const song of songs.slice(MAX_CANDIDATES)) {
        const stored = store.get(where, identityOf(song));
        const spotifyTrackId = stored && acceptedId(stored, bpm);
        if (spotifyTrackId) {
          return { title: song.title, artist: song.artist, bpm: song.bpm, spotifyTrackId };
        }
      }
      throw busy;
    },

    async luckySong(market, excludeBpm) {
      if (!verifier) {
        throw new LuckyDisabledError();
      }

      try {
        return await searchLucky(verifier, market, excludeBpm);
      } catch (err) {
        const stored = err instanceof BusyError && storedLucky(market ?? catalog.market, excludeBpm);
        if (!stored) {
          throw err;
        }
        return stored;
      }
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
    const bpm = luckyBpm(features[i], excludeBpm);
    if (bpm !== null) {
      return { ...track, bpm };
    }
  }
  return null;
}

/** The rounded tempo of a song fit for a lucky pick, or null. */
function luckyBpm(
  { tempo, speechiness }: TrackFeatures,
  excludeBpm: number | undefined,
): number | null {
  if (tempo === null || isSpoken(speechiness)) {
    return null;
  }

  const bpm = Math.round(tempo);
  return bpm >= MIN_BPM && bpm <= MAX_BPM && bpm !== excludeBpm ? bpm : null;
}

function acceptedId(stored: Resolution, bpm: number): string | null {
  return stored.outcome === 'found' && !rejectionOf(stored, bpm) ? stored.spotifyTrackId : null;
}

function rejectionOf({ tempo, speechiness }: TrackFeatures, bpm: number): Rejection | null {
  if (tempo !== null && Math.abs(tempo - bpm) > TEMPO_TOLERANCE_BPM) {
    return 'tempo';
  }
  return isSpoken(speechiness) ? 'spoken' : null;
}

function identityOf({ title, artist, isrc }: TempoSong): string {
  return isrc ? `isrc:${isrc}` : JSON.stringify([normalizeTitle(title), normalize(artist)]);
}

function isSpoken(speechiness: number | null): boolean {
  return speechiness !== null && speechiness >= SPOKEN_WORD_SPEECHINESS;
}

async function songsAt(providers: SongProvider[], bpm: number): Promise<TempoSong[]> {
  const results = await Promise.allSettled(providers.map((provider) => provider.songsAt(bpm)));
  const listed = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const songs = dedupe(listed.filter((song) => song.bpm === bpm && !NON_SONG_TITLE.test(song.title)));

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
