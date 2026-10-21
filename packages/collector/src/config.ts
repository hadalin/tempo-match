import { join } from 'node:path';
import { InvalidConfigError, MissingConfigError } from './errors.ts';
import { DEFAULT_SPOTIFY_DAILY_CALLS } from './policies.ts';

const DEFAULT_MARKET = 'US';
const DEFAULT_PORT = 3001;
const CATALOG_FILE = 'catalog.db';
const DISABLED_VALUES = ['false', '0'];
const REQUIRED_VARS = ['GETSONGBPM_API_KEY', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'] as const;

export type Env = Record<string, string | undefined>;

export interface Config {
  getSongBpmApiKey: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  /** The one market whose picks are collected and served to every country. */
  market: string;
  spotifyDailyCalls: number;
  deezer: boolean;
  reccoBeats: boolean;
  catalogPath: string;
  port: number;
}

/** The catalog file and market, which the admin command needs without the API keys. */
export function catalogConfig(env: Env): Pick<Config, 'catalogPath' | 'market' | 'reccoBeats'> {
  return {
    catalogPath: join(env.DATA_DIR || '.', CATALOG_FILE),
    market: (env.SPOTIFY_MARKET || DEFAULT_MARKET).toUpperCase(),
    reccoBeats: isEnabled(env.RECCOBEATS_ENABLED),
  };
}

export function collectorConfig(env: Env): Config {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  return {
    ...catalogConfig(env),
    getSongBpmApiKey: env.GETSONGBPM_API_KEY!,
    spotifyClientId: env.SPOTIFY_CLIENT_ID!,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET!,
    spotifyDailyCalls: spotifyDailyCalls(env.SPOTIFY_DAILY_CALLS),
    deezer: isEnabled(env.DEEZER_ENABLED),
    port: Number(env.PORT) || DEFAULT_PORT,
  };
}

function spotifyDailyCalls(value: string | undefined): number {
  if (!value) {
    return DEFAULT_SPOTIFY_DAILY_CALLS;
  }
  const calls = Number(value);
  if (!/^\d+$/.test(value) || calls <= 0) {
    throw new InvalidConfigError('SPOTIFY_DAILY_CALLS', value, 'a positive whole number');
  }
  return calls;
}

function isEnabled(flag: string | undefined): boolean {
  return !DISABLED_VALUES.includes(flag?.toLowerCase() ?? '');
}
