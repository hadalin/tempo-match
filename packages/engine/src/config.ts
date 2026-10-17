import { deezer } from './deezer.ts';
import { createEngine, type TempoEngine } from './engine.ts';
import { MissingConfigError } from './errors.ts';
import { getSongBpm } from './getsongbpm.ts';
import { reccoBeats } from './reccobeats.ts';
import { spotify } from './spotify.ts';
import { openSongStore } from './store.ts';

const DEFAULT_MARKET = 'US';
const DEFAULT_SONG_STORE_PATH = 'songs.db';
const DISABLED_VALUES = ['false', '0'];
const REQUIRED_VARS = ['GETSONGBPM_API_KEY', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'] as const;

export type Env = Record<string, string | undefined>;

export function engineFromEnv(env: Env): TempoEngine {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }

  const providers = [getSongBpm(env.GETSONGBPM_API_KEY!)];
  if (isEnabled(env.DEEZER_ENABLED)) {
    providers.push(deezer());
  }
  const catalog = spotify({
    clientId: env.SPOTIFY_CLIENT_ID!,
    clientSecret: env.SPOTIFY_CLIENT_SECRET!,
    market: env.SPOTIFY_MARKET || DEFAULT_MARKET,
  });
  const verifier = isEnabled(env.RECCOBEATS_ENABLED) ? reccoBeats() : undefined;
  const store = openSongStore(env.SONG_STORE_PATH || DEFAULT_SONG_STORE_PATH);
  return createEngine(providers, catalog, Math.random, verifier, store);
}

function isEnabled(flag: string | undefined): boolean {
  return !DISABLED_VALUES.includes(flag?.toLowerCase() ?? '');
}
