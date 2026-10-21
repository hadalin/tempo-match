import { DAY_MS } from '@tempo-match/catalog';
import type { Policy } from './dispatcher.ts';
import { SECOND_MS } from './upstream.ts';

// About 700 calls in 40 minutes, one per 3 s, got the app blocked for 19 hours, so the daily
// calls are spread over the whole day.
export const DEFAULT_SPOTIFY_DAILY_CALLS = 1_000;
export function spotifyPolicy(dailyCalls: number): Policy {
  return {
    service: 'spotify',
    spacingMs: DAY_MS / dailyCalls,
    // A fixed gap reads as a machine-timed job.
    spacingJitter: 0.5,
    dailyCalls,
    dailyRechecks: 100,
  };
}
export const SPOTIFY = spotifyPolicy(DEFAULT_SPOTIFY_DAILY_CALLS);
export const RECCOBEATS: Policy = { service: 'reccobeats', spacingMs: 60 * SECOND_MS, spacingJitter: 0, dailyCalls: Infinity, dailyRechecks: 0 };
// GetSongBPM allows 3,000 requests an hour; this sends at most 180.
export const GETSONGBPM: Policy = { service: 'getsongbpm', spacingMs: 20 * SECOND_MS, spacingJitter: 0, dailyCalls: Infinity, dailyRechecks: 0 };
// Under 5% of Deezer's reported 50 requests per 5 seconds.
export const DEEZER: Policy = { service: 'deezer', spacingMs: 2 * SECOND_MS, spacingJitter: 0, dailyCalls: Infinity, dailyRechecks: 0 };
