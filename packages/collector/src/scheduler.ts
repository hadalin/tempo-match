import type { DatabaseSync } from 'node:sqlite';
import {
  DAY_MS,
  MAX_BPM,
  MIN_BPM,
  PICK_LIFETIME_MS,
  REFRESH_AFTER_MS,
  type Features,
  type Suspect,
  type Transitions,
} from '@tempo-match/catalog';
import type { Clock } from './clock.ts';
import { CallKind, type Dispatcher } from './dispatcher.ts';
import { retriesLater } from './errors.ts';
import { MAX_FEATURE_IDS, type FeatureSource } from './reccobeats.ts';
import type { LookupSong, SpotifyLookup } from './spotify.ts';

const RECHECK_COOLDOWN_MS = DAY_MS;
// An ISRC lookup that misses needs a title search too.
const SEARCHES_PER_RECHECK = 2;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const TOP_CANDIDATES = 50;
const CENTER_BPM = 120;

export const Job = {
  Recheck: 'recheck',
  Refresh: 'refresh',
  Fill: 'fill',
} as const;
export type Job = (typeof Job)[keyof typeof Job];

export interface SpotifyJobs {
  /** Runs the most urgent Spotify job: re-check, then refresh, then fill. Null when idle. */
  step(): Promise<Job | null>;
}

export interface SchedulerOptions {
  market: string;
  transitions: Transitions;
  spotify: SpotifyLookup;
  calls: Dispatcher;
  clock: Clock;
  /** The suspects of the matcher's last report, most flagged first. */
  suspects: () => Suspect[];
  random?: () => number;
}

export function spotifyJobs(db: DatabaseSync, options: SchedulerOptions): SpotifyJobs {
  const { market, transitions: t, spotify, calls, clock, suspects, random = Math.random } = options;
  const recheckTarget = db.prepare(`
    SELECT identity FROM picks WHERE spotify_track_id = ? AND market = ? AND looked_up_at <= ? LIMIT 1
  `);
  const oldest = db.prepare('SELECT identity, looked_up_at FROM picks WHERE market = ? ORDER BY looked_up_at LIMIT 1');
  const idsPerBpm = db.prepare(`
    SELECT bpm, count(*) AS ids FROM picks WHERE market = ? AND looked_up_at > ? GROUP BY bpm
  `);
  const candidates = db.prepare(`
    SELECT s.identity FROM songs s
    WHERE s.bpm = :bpm AND s.status = 'ok'
      AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.market = :market AND p.identity = s.identity)
      AND NOT EXISTS (SELECT 1 FROM misses m WHERE m.market = :market AND m.identity = s.identity)
    ORDER BY s.popularity DESC LIMIT ${TOP_CANDIDATES}
  `);
  const songName = db.prepare(`
    SELECT title, artist FROM songs WHERE identity = ? AND status = 'ok' ORDER BY popularity DESC LIMIT 1
  `);
  const songIsrc = db.prepare(`
    SELECT isrc FROM songs WHERE identity = ? AND isrc IS NOT NULL ORDER BY popularity DESC LIMIT 1
  `);
  const callsToday = db.prepare("SELECT calls, recheck_calls FROM upstream WHERE service = 'spotify'");
  let sweptAt = -Infinity;

  function lookupSong(identity: string): LookupSong | null {
    const name = songName.get(identity);
    if (!name) {
      return null;
    }
    const isrc = songIsrc.get(identity)?.isrc;
    return { title: String(name.title), artist: String(name.artist), isrc: typeof isrc === 'string' ? isrc : null };
  }

  /** Looks the song up and stores the answer; a lookup that can never succeed counts as not found. */
  async function lookUp(identity: string, kind: CallKind): Promise<string | null> {
    const song = lookupSong(identity);
    if (!song) {
      return null;
    }

    let id: string | null;
    try {
      id = await spotify.lookup(song, market, kind);
    } catch (err) {
      if (retriesLater(err)) {
        throw err;
      }
      console.error(`Spotify lookup of ${identity} failed, stored as not found:`, err);
      id = null;
    }
    t.applyLookup(market, identity, id, clock.now());
    return id;
  }

  function sweepIfDue() {
    const now = clock.now();
    if (now - sweptAt < SWEEP_EVERY_MS) {
      return;
    }
    sweptAt = now;
    t.sweep(market, now);
    const today = callsToday.get();
    console.log(`Spotify today: ${today?.calls} calls, ${today?.recheck_calls} of them re-checks`);
  }

  async function recheck(): Promise<boolean> {
    for (const suspect of suspects()) {
      if (suspect.market !== market) {
        continue;
      }
      const target = recheckTarget.get(suspect.spotifyTrackId, market, clock.now() - RECHECK_COOLDOWN_MS);
      if (!target) {
        continue;
      }
      if (calls.rechecksLeft() < SEARCHES_PER_RECHECK) {
        return false;
      }

      const identity = String(target.identity);
      const id = await lookUp(identity, CallKind.Recheck);
      const outcome = id === suspect.spotifyTrackId ? 'kept' : id === null ? 'removed' : `swapped for ${id}`;
      console.log(`Re-check of ${suspect.spotifyTrackId} (${identity}): ${outcome}`);
      return true;
    }
    return false;
  }

  async function refresh(): Promise<boolean> {
    const row = oldest.get(market);
    if (!row || Number(row.looked_up_at) > clock.now() - REFRESH_AFTER_MS) {
      return false;
    }
    await lookUp(String(row.identity), CallKind.Plain);
    return true;
  }

  async function fill(): Promise<boolean> {
    const counts = new Map(
      idsPerBpm.all(market, clock.now() - PICK_LIFETIME_MS).map((row) => [Number(row.bpm), Number(row.ids)]),
    );
    const bpms = Array.from({ length: MAX_BPM - MIN_BPM + 1 }, (_, i) => MIN_BPM + i).sort(
      (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || Math.abs(a - CENTER_BPM) - Math.abs(b - CENTER_BPM),
    );
    for (const bpm of bpms) {
      const found = candidates.all({ bpm, market });
      if (found.length === 0) {
        continue;
      }
      const identity = String(found[Math.floor(random() * found.length)].identity);
      await lookUp(identity, CallKind.Plain);
      return true;
    }
    return false;
  }

  return {
    async step() {
      sweepIfDue();
      if (await recheck()) {
        return Job.Recheck;
      }
      if (await refresh()) {
        return Job.Refresh;
      }
      if (await fill()) {
        return Job.Fill;
      }
      return null;
    },
  };
}

export interface FeatureChecks {
  /** Asks ReccoBeats about the next batch of unchecked picks; false when none is unchecked. */
  step(): Promise<boolean>;
}

export function featureChecks(
  db: DatabaseSync,
  t: Transitions,
  features: FeatureSource,
  clock: Clock,
): FeatureChecks {
  const unchecked = db.prepare(
    `SELECT DISTINCT spotify_track_id AS id FROM picks WHERE features_at IS NULL LIMIT ${MAX_FEATURE_IDS}`,
  );

  return {
    async step() {
      const ids = unchecked.all().map((row) => String(row.id));
      if (ids.length === 0) {
        return false;
      }

      let found = new Map<string, Features | null>();
      try {
        found = await features.featuresOf(ids);
      } catch (err) {
        if (retriesLater(err)) {
          throw err;
        }
        console.error('ReccoBeats check failed, keeping the picks unverified:', err);
      }
      for (const id of ids) {
        t.applyFeatures(id, found.get(id) ?? null, clock.now());
      }
      return true;
    },
  };
}
