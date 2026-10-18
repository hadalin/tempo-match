import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { DAY_MS, MAX_BPM, MIN_BPM, PICK_LIFETIME_MS, UNTIL_UNBLOCKED, utcDay } from '@tempo-match/catalog';
import { DEEZER_MAX_BPM, DEEZER_MIN_BPM, DEEZER_SEEDS } from './deezer.ts';
import { RESPONSE_FORMAT } from './errors.ts';

const ACCEPTED_IDS = 5;
const FEW_SONGS = 20;
const WAL_WARNING_BYTES = 64 * 1024 * 1024;
const LONG_BAN_MS = 7 * DAY_MS;
const MB = 1024 * 1024;
const CRAWL_ITEMS: Record<string, number> = {
  getsongbpm: MAX_BPM - MIN_BPM + 1,
  deezer: (DEEZER_MAX_BPM - DEEZER_MIN_BPM + 1) * DEEZER_SEEDS.length,
};

export const Verification = {
  Checked: 'checked',
  Unverified: 'unverified',
} as const;
export type Verification = (typeof Verification)[keyof typeof Verification];

interface Service {
  service: string;
  day: number;
  calls: number;
  recheck_calls: number;
  banned_until: number;
  ban_reason: string | null;
  held_until: number;
  hold_reason: string | null;
  failures: number;
}

/**
 * Whether the catalog serves the market well: a finished GetSongBPM pass, Spotify not held for
 * its response format, and at least 5 different ids at every BPM Deezer covers, counting only
 * picks whose ReccoBeats check finished unless checks are off.
 */
export function acceptance(db: DatabaseSync, market: string, now: number, verification: Verification): string {
  const short: number[] = [];
  const checked = verification === Verification.Checked ? 'AND features_at IS NOT NULL' : '';
  const ids = new Map(
    db.prepare(`SELECT bpm, count(*) AS ids FROM picks WHERE market = ? AND looked_up_at > ? ${checked} GROUP BY bpm`)
      .all(market, now - PICK_LIFETIME_MS)
      .map((row) => [Number(row.bpm), Number(row.ids)]),
  );
  for (let bpm = DEEZER_MIN_BPM; bpm <= DEEZER_MAX_BPM; bpm++) {
    if ((ids.get(bpm) ?? 0) < ACCEPTED_IDS) {
      short.push(bpm);
    }
  }

  const problems = [];
  if (!passDone(db, 'getsongbpm')) {
    problems.push('no complete GetSongBPM pass');
  }
  const hold = db.prepare("SELECT hold_reason FROM upstream WHERE service = 'spotify' AND held_until > ?").get(now);
  if (String(hold?.hold_reason ?? '').includes(RESPONSE_FORMAT)) {
    problems.push('Spotify held for its response format');
  }
  if (short.length > 0) {
    problems.push(`under ${ACCEPTED_IDS} ids at ${ranges(short)} BPM`);
  }
  if (problems.length > 0) {
    return `not met: ${problems.join('; ')}`;
  }
  return verification === Verification.Checked ? 'met' : 'met (unverified)';
}

export function status(
  db: DatabaseSync,
  path: string,
  market: string,
  now: number,
  verification: Verification,
): string {
  const lines = ['Upstream services'];
  for (const row of db.prepare('SELECT * FROM upstream ORDER BY service').all() as unknown as Service[]) {
    lines.push(`  ${serviceLine(row, now)}`);
  }

  lines.push('Catalog');
  const songs = db.prepare("SELECT bpm, count(*) AS n FROM songs WHERE status = 'ok' GROUP BY bpm").all();
  const total = songs.reduce((sum, row) => sum + Number(row.n), 0);
  const few = songs.filter((row) => Number(row.n) < FEW_SONGS).map((row) => Number(row.bpm));
  lines.push(`  ${total} songs at ${songs.length} BPMs; under ${FEW_SONGS} songs at ${ranges(few) || 'none'}`);
  for (const source of ['getsongbpm', 'deezer']) {
    const done = passDone(db, source);
    lines.push(`  ${source}: ${done ? `last complete pass ${iso(done)}` : 'no complete pass yet'}`);
  }

  const expired = now - PICK_LIFETIME_MS;
  const picks = db.prepare(`SELECT count(*) AS n, count(DISTINCT bpm) AS bpms, min(looked_up_at) AS oldest,
      sum(features_at IS NULL) AS unchecked FROM picks WHERE market = ? AND looked_up_at > ?`).get(market, expired);
  const candidates = new Set(
    db.prepare(`SELECT DISTINCT s.bpm FROM songs s WHERE s.status = 'ok'
        AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.market = :market AND p.identity = s.identity)
        AND NOT EXISTS (SELECT 1 FROM misses m WHERE m.market = :market AND m.identity = s.identity)`)
      .all({ market })
      .map((row) => Number(row.bpm)),
  );
  const served = new Set(
    db.prepare('SELECT DISTINCT bpm FROM picks WHERE market = ? AND looked_up_at > ?').all(market, expired).map((r) => Number(r.bpm)),
  );
  const empty = songs.map((row) => Number(row.bpm)).filter((bpm) => !served.has(bpm));
  const outOfCandidates = songs.map((row) => Number(row.bpm)).filter((bpm) => !candidates.has(bpm));
  const n = Number(picks?.n ?? 0);
  lines.push(`Picks in ${market}`);
  lines.push(`  ${n} ids at ${picks?.bpms} BPMs; oldest lookup ${picks?.oldest ? iso(Number(picks.oldest)) : 'none'}; ` +
    `unchecked ${n ? Math.round((Number(picks?.unchecked) / n) * 100) : 0}%`);
  lines.push(`  BPMs with songs but no pick: ${ranges(empty) || 'none'}`);
  lines.push(`  BPMs out of candidates: ${ranges(outOfCandidates) || 'none'}`);
  const found = db.prepare('SELECT count(DISTINCT identity) AS n FROM picks WHERE market = ? AND looked_up_at > ?').get(market, now - DAY_MS);
  const missed = db.prepare('SELECT reason, count(*) AS n FROM misses WHERE market = ? GROUP BY reason').all(market);
  const missedToday = db.prepare('SELECT count(*) AS n FROM misses WHERE market = ? AND looked_up_at > ?').get(market, now - DAY_MS);
  lines.push(`  last 24 h: ${found?.n} songs found, ${missedToday?.n} missed`);
  lines.push(`  misses: ${missed.map((row) => `${row.reason} ${row.n}`).join(', ') || 'none'}`);
  lines.push(`  acceptance: ${acceptance(db, market, now, verification)}`);

  lines.push('Countries today (UTC)');
  const countries = db.prepare('SELECT * FROM country_daily WHERE day = ? ORDER BY served + fallback DESC').all(utcDay(now));
  for (const row of countries) {
    lines.push(`  ${row.country}: served ${row.served}, fallback ${row.fallback}, empty ${row.empty}, dead ${row.dead}`);
  }

  const wal = walBytes(path);
  lines.push(`WAL ${(wal / MB).toFixed(1)} MB${wal > WAL_WARNING_BYTES ? ' (large: checkpoints are not keeping up)' : ''}`);
  return lines.join('\n');
}

function serviceLine(row: Service, now: number): string {
  const today = row.day === utcDay(now);
  const parts = [`${row.service}: ${today ? row.calls : 0} calls today`];
  if (row.service === 'spotify') {
    parts.push(`${today ? row.recheck_calls : 0} re-check searches`);
  }
  if (row.banned_until > now) {
    const long = row.banned_until - now > LONG_BAN_MS ? ' (over 7 days: check it, clear-ban if implausible)' : '';
    parts.push(`banned until ${iso(row.banned_until)} (${row.ban_reason})${long}`);
  }
  if (row.held_until > now) {
    const until = row.held_until === UNTIL_UNBLOCKED ? 'unblocked' : iso(row.held_until);
    parts.push(`held until ${until} (${row.hold_reason})`);
  }
  parts.push(`${row.failures} failures`);
  return parts.join(', ');
}

function passDone(db: DatabaseSync, source: string): number | null {
  const row = db.prepare('SELECT count(done_at) AS done, min(done_at) AS oldest FROM crawl_state WHERE source = ?').get(source);
  return Number(row?.done) >= CRAWL_ITEMS[source] ? Number(row?.oldest) : null;
}

function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

/** "60-62, 70" for [60, 61, 62, 70]. */
export function ranges(bpms: number[]): string {
  const sorted = [...bpms].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (sorted[i + 1] === sorted[i] + 1) {
      i++;
    }
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(', ');
}

function iso(time: number): string {
  return new Date(time).toISOString();
}
