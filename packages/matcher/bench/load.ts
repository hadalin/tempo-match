// Load test of the matcher against a synthetic catalog; makes no upstream call.
// node --no-warnings packages/matcher/bench/load.ts [requests per second] [seconds] [lucky|mixed]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { identityOf, MAX_BPM, MIN_BPM, openWriter, SOURCE_DEEZER, transitions } from '@tempo-match/catalog';

const [rate = 200, seconds = 60] = process.argv.slice(2, 4).map(Number);
const mix = process.argv[4] === 'lucky' ? 'lucky' : 'mixed';
const PORT = 3990;
const LISTINGS = 150_000;
const PICKED_SHARE = 0.4;
const WRITE_EVERY_MS = 100;
const MARKET = 'US';
const COUNTRIES = ['DE', 'GB', 'SI', 'FR'];
const EMPTY_BPM = 150;

function gaussianBpm(): number {
  const u = 1 - Math.random();
  const bpm = Math.round(118 + 28 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()));
  return Math.min(Math.max(bpm, MIN_BPM), MAX_BPM);
}

function trackId(n: number): string {
  return n.toString(36).padStart(22, '0');
}

const dir = mkdtempSync(join(tmpdir(), 'matcher-bench-'));
const db = openWriter(join(dir, 'catalog.db'));
const t = transitions(db);
const now = Date.now();
console.log(`Generating ${LISTINGS} listings in ${dir}`);
const identities: string[] = [];
for (let start = 0; start < LISTINGS; start += 1000) {
  const listings = Array.from({ length: 1000 }, (_, i) => {
    const identity = identityOf(`Song ${start + i}`, 'Artist');
    identities.push(identity);
    return { identity, bpm: gaussianBpm(), title: `Song ${start + i}`, artist: 'Artist', popularity: Math.random(), source: SOURCE_DEEZER };
  });
  t.upsertListings(listings, now);
}
const pick = db.prepare(`INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, features_at, shuffle)
  SELECT ?, bpm, identity, ?, ?, ?, ? FROM songs WHERE identity = ?`);
db.exec('BEGIN');
identities.slice(0, LISTINGS * PICKED_SHARE).forEach((identity, i) => {
  pick.run(MARKET, trackId(i), now, now, Math.random(), identity);
});
db.exec('COMMIT');
db.prepare('DELETE FROM picks WHERE bpm = ?').run(EMPTY_BPM);
const picks = db.prepare('SELECT spotify_track_id AS id, bpm FROM picks').all().map((r) => ({ id: String(r.id), bpm: Number(r.bpm) }));
console.log(`${picks.length} picks`);

// The collector commits a lookup about every 3 s; this writes 30 times as often, in its own thread.
const writer = new Worker(new URL('./writer.ts', import.meta.url), {
  workerData: { path: join(dir, 'catalog.db'), market: MARKET, identities, firstId: LISTINGS, everyMs: WRITE_EVERY_MS },
});

const matcher = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, '../src/main.ts')], {
  env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), SPOTIFY_MARKET: MARKET, COLLECTOR_URL: '' },
  stdio: 'inherit',
});
await delay(1000);

function target(): { path: string; headers: Record<string, string> } {
  const pick = picks[Math.floor(Math.random() * picks.length)];
  const roll = mix === 'lucky' ? 0.7 : Math.random();
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1`;
  if (roll < 0.6) {
    return { path: `/api/song?bpm=${pick.bpm}&skip=${pick.id}`, headers: { 'CF-IPCountry': MARKET } };
  }
  if (roll < 0.7) {
    return { path: `/api/song?bpm=${pick.bpm}`, headers: { 'CF-IPCountry': COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)] } };
  }
  if (roll < 0.85) {
    return { path: `/api/song?lucky=1&exclude=${pick.bpm}&skip=${pick.id}`, headers: { 'CF-IPCountry': MARKET } };
  }
  if (roll < 0.95) {
    return { path: `/api/song?bpm=${EMPTY_BPM}`, headers: { 'CF-IPCountry': MARKET } };
  }
  return { path: `/api/song?bpm=${pick.bpm}&dead=${pick.id}`, headers: { 'CF-IPCountry': MARKET, 'CF-Connecting-IP': ip } };
}

console.log(`Open loop, ${rate} requests per second for ${seconds} s, ${mix}`);
const latencies: number[] = [];
const statuses = new Map<number, number>();
const pending: Promise<void>[] = [];
const started = performance.now();
for (let i = 0; i < rate * seconds; i++) {
  const due = started + (i * 1000) / rate;
  const wait = due - performance.now();
  if (wait > 0) {
    await delay(wait);
  }
  const { path, headers } = target();
  pending.push(
    fetch(`http://127.0.0.1:${PORT}${path}`, { headers }).then(async (res) => {
      await res.arrayBuffer();
      latencies.push(performance.now() - due);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }, () => {
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
    }),
  );
}
await Promise.all(pending);
writer.postMessage('stop');
const [written] = await once(writer, 'message');
await writer.terminate();
matcher.kill();

latencies.sort((a, b) => a - b);
const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(2);
console.log(`p50 ${at(0.5)} ms, p99 ${at(0.99)} ms, max ${at(1)} ms; statuses ${JSON.stringify(Object.fromEntries(statuses))}; ${written} writes`);
db.close();
rmSync(dir, { recursive: true, force: true });
