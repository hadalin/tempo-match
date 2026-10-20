import type { DatabaseSync } from 'node:sqlite';
import { SERVICES, transaction, UNTIL_UNBLOCKED, type Service } from '@tempo-match/catalog';
import { status, Verification } from './status.ts';

const ALL = 'all';
const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;
const USAGE = `Usage:
  admin.ts status
  admin.ts hold <service|all> --reason <text>
  admin.ts unblock <service|all> [--not-before <ISO time>]
  admin.ts clear-ban <service> --reason <text>
  admin.ts reject <spotify-track-id>
Services: ${SERVICES.join(', ')}`;

export class UsageError extends Error {
  constructor(problem: string) {
    super(`${problem}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export interface AdminContext {
  db: DatabaseSync;
  path: string;
  market: string;
  verification: Verification;
  now: number;
}

/**
 * Runs one operator command against the catalog and returns what to print. Holds and bans
 * change only upstream rows; a rejection deletes the picks of a track and keeps their songs out
 * for good. No command calls an upstream service.
 */
export function runCommand(args: string[], context: AdminContext): string {
  const [command, target, ...rest] = args;
  const { db, now } = context;
  if (command === 'status') {
    return status(db, context.path, context.market, now, context.verification);
  }
  if (command === 'hold') {
    const reason = option(rest, '--reason');
    update(db, services(target), 'UPDATE upstream SET held_until = ?, hold_reason = ? WHERE service = ?', UNTIL_UNBLOCKED, reason);
    return `held ${target} until unblocked: ${reason}`;
  }
  if (command === 'unblock') {
    const notBefore = optionalTime(rest, '--not-before') ?? now;
    update(db, services(target), 'UPDATE upstream SET held_until = ?, hold_reason = ? WHERE service = ?', notBefore, 'operator not-before');
    return `unblocked ${target} from ${new Date(notBefore).toISOString()}; bans stay`;
  }
  if (command === 'clear-ban') {
    const reason = option(rest, '--reason');
    const service = oneService(target);
    update(db, [service], 'UPDATE upstream SET banned_until = 0, ban_reason = ?, failures = 0 WHERE service = ?', `cleared: ${reason}`);
    return `cleared the ban of ${service}: ${reason}`;
  }
  if (command === 'reject') {
    return reject(db, trackId(target));
  }
  throw new UsageError(command ? `Unknown command "${command}"` : 'No command');
}

function update(db: DatabaseSync, targets: Service[], sql: string, ...values: (string | number)[]) {
  const statement = db.prepare(sql);
  transaction(db, () => {
    for (const service of targets) {
      statement.run(...values, service);
    }
  });
}

// Misses keep no Spotify id, so the rejection is a spoken-word miss of each song that held the
// track, dated so that no sweep expires it.
function reject(db: DatabaseSync, id: string): string {
  const held = transaction(db, () => {
    const songs = db.prepare('SELECT DISTINCT market, identity FROM picks WHERE spotify_track_id = ?').all(id);
    const { changes } = db.prepare('DELETE FROM picks WHERE spotify_track_id = ?').run(id);
    const putMiss = db.prepare(`
      INSERT INTO misses (market, identity, reason, looked_up_at) VALUES (?, ?, 'spoken', ?)
      ON CONFLICT (market, identity) DO UPDATE SET reason = excluded.reason, looked_up_at = excluded.looked_up_at
    `);
    for (const { market, identity } of songs) {
      putMiss.run(String(market), String(identity), UNTIL_UNBLOCKED);
    }
    return { picks: Number(changes), songs: songs.length };
  });
  if (held.songs === 0) {
    return `no picks of ${id}; nothing rejected`;
  }
  return `rejected ${id}: removed ${held.picks} picks of ${held.songs} song${held.songs === 1 ? '' : 's'}`;
}

function trackId(target: string | undefined): string {
  if (!target || !SPOTIFY_TRACK_ID.test(target)) {
    throw new UsageError(`"${target ?? ''}" is not a Spotify track id`);
  }
  return target;
}

function services(target: string | undefined): Service[] {
  return target === ALL ? [...SERVICES] : [oneService(target)];
}

function oneService(target: string | undefined): Service {
  const service = SERVICES.find((s) => s === target);
  if (!service) {
    throw new UsageError(`Unknown service "${target ?? ''}"`);
  }
  return service;
}

function option(args: string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || !value) {
    throw new UsageError(`Missing ${name}`);
  }
  return value;
}

function optionalTime(args: string[], name: string): number | undefined {
  if (!args.includes(name)) {
    return undefined;
  }
  const time = Date.parse(option(args, name));
  if (Number.isNaN(time)) {
    throw new UsageError(`${name} must be an ISO time`);
  }
  return time;
}
