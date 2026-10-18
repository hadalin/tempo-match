import type { Features } from '@tempo-match/catalog';
import { CallKind, type Dispatcher } from './dispatcher.ts';
import { request } from './upstream.ts';

const AUDIO_FEATURES_URL = 'https://api.reccobeats.com/v1/audio-features';
const SERVICE = 'ReccoBeats';
export const MAX_FEATURE_IDS = 40;

interface AudioFeatures {
  href?: string;
  tempo?: number;
  speechiness?: number;
}

export interface FeatureSource {
  /** Tempo and speechiness per Spotify track id, null where ReccoBeats has no data. */
  featuresOf(spotifyTrackIds: string[]): Promise<Map<string, Features | null>>;
}

export function reccoBeats(calls: Dispatcher, fetchFn: typeof fetch = fetch): FeatureSource {
  return {
    featuresOf: (ids) =>
      calls.call(CallKind.Plain, async () => {
        const url = new URL(AUDIO_FEATURES_URL);
        url.searchParams.set('ids', ids.join(','));
        const res = await request(SERVICE, fetchFn, url);

        // Rows carry no Spotify id field and unknown ids are left out, so rows are matched by link.
        const body = (await res.json()) as { content?: AudioFeatures[] };
        return new Map(
          ids.map((id) => {
            const row = body.content?.find((r) => r.href?.endsWith(`/track/${id}`));
            return [id, row ? featuresOf(row) : null];
          }),
        );
      }),
  };
}

function featuresOf({ tempo, speechiness }: AudioFeatures): Features | null {
  const features = {
    tempo: typeof tempo === 'number' && tempo > 0 ? tempo : null,
    speechiness: typeof speechiness === 'number' ? speechiness : null,
  };
  return features.tempo === null && features.speechiness === null ? null : features;
}
