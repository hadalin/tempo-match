import type { Policy } from './dispatcher.ts';
import { SECOND_MS } from './upstream.ts';

// About 300 searches in 2.5 minutes got the app blocked for 14 hours; this is a sixth of that rate.
export const SPOTIFY: Policy = { service: 'spotify', spacingMs: 3 * SECOND_MS, dailyCalls: 5_000, dailyRechecks: 100 };
export const RECCOBEATS: Policy = { service: 'reccobeats', spacingMs: 60 * SECOND_MS, dailyCalls: Infinity, dailyRechecks: 0 };
// GetSongBPM allows 3,000 requests an hour; this sends at most 180.
export const GETSONGBPM: Policy = { service: 'getsongbpm', spacingMs: 20 * SECOND_MS, dailyCalls: Infinity, dailyRechecks: 0 };
// Under 5% of Deezer's reported 50 requests per 5 seconds.
export const DEEZER: Policy = { service: 'deezer', spacingMs: 2 * SECOND_MS, dailyCalls: Infinity, dailyRechecks: 0 };
