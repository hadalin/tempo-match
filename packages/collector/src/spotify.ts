import { MIN_SONG_SECONDS, normalize, normalizeTitle } from '@tempo-match/catalog';
import { CallKind, type Dispatcher } from './dispatcher.ts';
import { ResponseFormatError, UpstreamError } from './errors.ts';
import { request, SECOND_MS } from './upstream.ts';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const SEARCH_LIMIT = 5;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const MIN_DURATION_MS = MIN_SONG_SECONDS * SECOND_MS;
const SEARCH = 'Spotify search';
const TOKEN = 'Spotify token';

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
}

export interface LookupSong {
  title: string;
  artist: string;
  isrc: string | null;
}

export interface SpotifyLookup {
  /**
   * The id of a track that Spotify marks playable in `market` and that is long enough to be a
   * song: by ISRC when the song has a valid one, else by title and artist. Null when none plays.
   * Throws ResponseFormatError when results lack `is_playable`, so a format change stores nothing.
   */
  lookup(song: LookupSong, market: string, kind: CallKind): Promise<string | null>;
}

interface Token {
  value: string;
  expiresAt: number;
}

interface SearchTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  duration_ms?: number;
  is_playable?: unknown;
  restrictions?: unknown;
}

export function spotify(
  creds: SpotifyCredentials,
  calls: Dispatcher,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): SpotifyLookup {
  let token: Token | null = null;

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAt) {
      return token.value;
    }

    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    token = await calls.call(CallKind.Plain, async () => {
      const res = await request(TOKEN, fetchFn, TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
        throw new UpstreamError(TOKEN, 'no token in the answer');
      }
      return { value: body.access_token, expiresAt: now() + body.expires_in * SECOND_MS - TOKEN_REFRESH_MARGIN_MS };
    });
    return token.value;
  }

  async function search(query: string, market: string, kind: CallKind): Promise<SearchTrack[]> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'track');
    url.searchParams.set('market', market);
    url.searchParams.set('limit', String(SEARCH_LIMIT));

    const bearer = await accessToken();
    return calls.call(kind, async () => {
      const res = await request(SEARCH, fetchFn, url, { headers: { Authorization: `Bearer ${bearer}` } });
      const body = (await res.json()) as { tracks?: { items?: SearchTrack[] } };
      const items = body.tracks?.items ?? [];
      if (items.some((item) => typeof item.is_playable !== 'boolean')) {
        throw new ResponseFormatError(SEARCH, 'a track without is_playable');
      }
      return items;
    });
  }

  return {
    async lookup({ title, artist, isrc }, market, kind) {
      if (isrc && ISRC_PATTERN.test(isrc)) {
        const byIsrc = (await search(`isrc:${isrc}`, market, kind)).find(isPlayable);
        if (byIsrc) {
          return byIsrc.id;
        }
      }

      const items = await search(`track:"${unquote(title)}" artist:"${unquote(artist)}"`, market, kind);
      const wantedTitle = normalizeTitle(title);
      const wantedArtist = normalize(artist);
      const track = items.find(
        (item) =>
          isPlayable(item) &&
          normalizeTitle(item.name) === wantedTitle &&
          item.artists.some((a) => normalize(a.name) === wantedArtist),
      );
      return track?.id ?? null;
    },
  };
}

function isPlayable(track: SearchTrack): boolean {
  const longEnough = track.duration_ms === undefined || track.duration_ms >= MIN_DURATION_MS;
  return track.is_playable === true && track.restrictions === undefined && longEnough;
}

function unquote(value: string): string {
  return value.replaceAll('"', '');
}
