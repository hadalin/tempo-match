import { type Cached, DAY_MS, ttlCache } from './cache.ts';
import { UpstreamError } from './errors.ts';
import { fetchUpstream, retryAfterMs, SECOND_MS } from './upstream.ts';
import type { TempoVerifier, TrackFeatures } from './verifier.ts';

const AUDIO_FEATURES_URL = 'https://api.reccobeats.com/v1/audio-features';
const TRACK_URL = 'https://api.reccobeats.com/v1/track';
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30 * DAY_MS;
const MAX_CACHED_FEATURES = 10_000;
const MAX_CACHED_POPULARITIES = 10_000;
const SERVICE = 'ReccoBeats';
const BACK_OFF_MS = 30 * SECOND_MS;
const MAX_BACK_OFF_MS = 120 * SECOND_MS;

interface Row {
  href?: string;
}

interface AudioFeatures extends Row {
  tempo?: number;
  speechiness?: number;
}

interface Track extends Row {
  popularity?: number;
}

interface BackOff {
  until: number;
  error: UpstreamError;
}

export function reccoBeats(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): TempoVerifier {
  const features = ttlCache<TrackFeatures>(CACHE_TTL_MS, MAX_CACHED_FEATURES, now);
  const popularities = ttlCache<number | null>(CACHE_TTL_MS, MAX_CACHED_POPULARITIES, now);
  let backOff: BackOff | undefined;

  function startBackOff(error: UpstreamError, ms: number): UpstreamError {
    backOff = { until: now() + ms, error };
    return error;
  }

  async function fetchRows<R extends Row>(
    endpoint: string,
    ids: string[],
  ): Promise<(R | undefined)[]> {
    // Rejecting instead of caching null keeps a transient failure from passing as missing data.
    if (backOff && now() < backOff.until) {
      throw backOff.error;
    }

    const url = new URL(endpoint);
    url.searchParams.set('ids', ids.join(','));

    const res = await fetchUpstream(SERVICE, fetchFn, url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err: UpstreamError) => {
      throw startBackOff(err, BACK_OFF_MS);
    });
    if (!res.ok) {
      const error = new UpstreamError(SERVICE, res.status);
      const retryAfter = res.headers.get('Retry-After');
      throw startBackOff(error, retryAfterMs(retryAfter, now(), BACK_OFF_MS, MAX_BACK_OFF_MS));
    }

    // Rows carry no Spotify id field and unknown ids are left out, so rows are matched by link.
    const body = (await res.json()) as { content?: R[] };
    return ids.map((id) => body.content?.find((row) => row.href?.endsWith(`/track/${id}`)));
  }

  async function fetchFeatures(ids: string[]): Promise<TrackFeatures[]> {
    const rows = await fetchRows<AudioFeatures>(AUDIO_FEATURES_URL, ids);
    return rows.map((row) => {
      const tempo = row?.tempo;
      const speechiness = row?.speechiness;
      return {
        tempo: typeof tempo === 'number' && tempo > 0 ? tempo : null,
        speechiness: typeof speechiness === 'number' ? speechiness : null,
      };
    });
  }

  async function fetchPopularities(ids: string[]): Promise<(number | null)[]> {
    const rows = await fetchRows<Track>(TRACK_URL, ids);
    return rows.map((row) => (typeof row?.popularity === 'number' ? row.popularity : null));
  }

  const featuresOfAll = (ids: string[]) => batched(features, ids, fetchFeatures);
  return {
    featuresOf: async (spotifyTrackId) => (await featuresOfAll([spotifyTrackId]))[0],
    featuresOfAll,
    popularityOf: (ids) => batched(popularities, ids, fetchPopularities),
  };
}

function batched<V>(
  cached: Cached<V>,
  ids: string[],
  load: (ids: string[]) => Promise<V[]>,
): Promise<V[]> {
  const uncached: string[] = [];
  const batch = Promise.withResolvers<V[]>();
  const values = ids.map((id) =>
    cached(id, () => {
      const index = uncached.push(id) - 1;
      return batch.promise.then((loaded) => loaded[index]);
    }),
  );

  if (uncached.length > 0) {
    load(uncached).then(batch.resolve, batch.reject);
  }
  return Promise.all(values);
}
