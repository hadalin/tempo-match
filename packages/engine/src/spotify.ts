import { tokenBucket } from './budget.ts';
import { DAY_MS, ttlCache } from './cache.ts';
import { BusyError, UpstreamError } from './errors.ts';
import { normalize, normalizeTitle } from './normalize.ts';
import type { TempoSong } from './provider.ts';
import { fetchUpstream, retryAfterMs, SECOND_MS } from './upstream.ts';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const SEARCH_LIMIT = 5;
// Spotify rejects a larger limit with "Invalid limit".
export const PAGE_LIMIT = 10;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CACHED_TRACKS = 10_000;
const MAX_CACHED_PAGES = 1024;
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const MIN_DURATION_MS = 90_000;
const SERVICE = 'Spotify';
const HTTP_TOO_MANY_REQUESTS = 429;
const BACK_OFF_MS = 30 * SECOND_MS;
// Spotify asked for 50,985 s once; a larger value is more likely a bad header than a longer ban.
const MAX_BACK_OFF_MS = DAY_MS;
// About 300 searches in 2.5 minutes got the app blocked for 14 hours.
const MAX_CALLS_PER_MINUTE = 30;
const MAX_BURST_CALLS = 10;

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  market: string;
}

export type TrackQuery = Pick<TempoSong, 'title' | 'artist' | 'isrc'>;

export interface CatalogTrack {
  spotifyTrackId: string;
  title: string;
  artist: string;
}

export interface TrackCatalog {
  /**
   * Looks the ISRC up first when it is valid, then searches by title and artist.
   * Tracks too short to be songs are never returned.
   */
  findTrackId(song: TrackQuery, market?: string): Promise<string | null>;
  /** One page of tracks for a free-text term, in Spotify's relevance order, minus short ones. */
  searchTracks(term: string, offset: number, market?: string): Promise<CatalogTrack[]>;
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
}

export function spotify(
  creds: SpotifyCredentials,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): TrackCatalog {
  let token: Token | null = null;
  let tokenRequest: Promise<Token> | null = null;
  const cached = ttlCache<string | null>(DAY_MS, MAX_CACHED_TRACKS, now);
  const cachedIsrcs = ttlCache<SearchTrack | null>(DAY_MS, MAX_CACHED_TRACKS, now);
  const cachedPages = ttlCache<CatalogTrack[]>(DAY_MS, MAX_CACHED_PAGES, now);
  const budget = tokenBucket(MAX_CALLS_PER_MINUTE, MAX_BURST_CALLS, now);
  let blockedUntil = -Infinity;

  /** Like fetchUpstream, but sends nothing while Spotify blocks the app or the budget is spent. */
  async function call(service: string, input: string | URL, init: RequestInit): Promise<Response> {
    if (now() < blockedUntil || !budget()) {
      throw new BusyError(SERVICE);
    }

    const res = await fetchUpstream(service, fetchFn, input, init);
    if (res.status !== HTTP_TOO_MANY_REQUESTS) {
      return res;
    }

    const waitMs = retryAfterMs(res.headers.get('Retry-After'), now(), BACK_OFF_MS, MAX_BACK_OFF_MS);
    blockedUntil = now() + waitMs;
    console.error(`${service} answered HTTP 429, pausing Spotify calls for ${waitMs / SECOND_MS} s`);
    throw new BusyError(SERVICE);
  }

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAt) {
      return token.value;
    }

    tokenRequest ??= requestToken().finally(() => {
      tokenRequest = null;
    });
    token = await tokenRequest;
    return token.value;
  }

  async function requestToken(): Promise<Token> {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const res = await call('Spotify token', TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new UpstreamError('Spotify token', res.status);
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    return {
      value: body.access_token,
      expiresAt: now() + body.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
  }

  async function search(
    query: string,
    market: string,
    limit = SEARCH_LIMIT,
    offset = 0,
  ): Promise<SearchTrack[]> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'track');
    url.searchParams.set('market', market);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const res = await call('Spotify search', url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new UpstreamError('Spotify search', res.status);
    }

    const body = (await res.json()) as { tracks?: { items?: SearchTrack[] } };
    return body.tracks?.items ?? [];
  }

  async function searchTrackId(
    title: string,
    artist: string,
    market: string,
  ): Promise<string | null> {
    const items = await search(`track:"${unquote(title)}" artist:"${unquote(artist)}"`, market);
    const wantedTitle = normalizeTitle(title);
    const wantedArtist = normalize(artist);
    const track = items.find(
      (item) =>
        isLongEnough(item) &&
        normalizeTitle(item.name) === wantedTitle &&
        item.artists.some((a) => normalize(a.name) === wantedArtist),
    );
    return track?.id ?? null;
  }

  async function isrcTrack(isrc: string, market: string): Promise<SearchTrack | null> {
    const [track] = await search(`isrc:${isrc}`, market);
    return track ?? null;
  }

  async function searchPage(term: string, offset: number, market: string): Promise<CatalogTrack[]> {
    const items = await search(term, market, PAGE_LIMIT, offset);
    return items.filter(isLongEnough).flatMap((item) => {
      const artist = item.artists[0]?.name;
      return artist ? [{ spotifyTrackId: item.id, title: item.name, artist }] : [];
    });
  }

  return {
    async findTrackId({ title, artist, isrc }, market = creds.market) {
      if (isrc && ISRC_PATTERN.test(isrc)) {
        const track = await cachedIsrcs(JSON.stringify([market, isrc]), () =>
          isrcTrack(isrc, market),
        );
        if (track) {
          return isLongEnough(track) ? track.id : null;
        }
      }
      return cached(JSON.stringify([market, title, artist]), () =>
        searchTrackId(title, artist, market),
      );
    },
    searchTracks(term, offset, market = creds.market) {
      return cachedPages(JSON.stringify([market, term, offset]), () =>
        searchPage(term, offset, market),
      );
    },
  };
}

function isLongEnough(track: SearchTrack): boolean {
  return track.duration_ms === undefined || track.duration_ms >= MIN_DURATION_MS;
}

function unquote(value: string): string {
  return value.replaceAll('"', '');
}
