import { DAY_MS, openWriter, SOURCE_DEEZER, SOURCE_GETSONGBPM, transitions } from '@tempo-match/catalog';
import { systemClock } from './clock.ts';
import { collectorConfig, type Config } from './config.ts';
import { crawler, crawlOrder, type CrawlSource } from './crawl.ts';
import {
  deezer,
  DEEZER_MAX_BPM,
  DEEZER_MAX_INDEX,
  DEEZER_MIN_BPM,
  DEEZER_PAGE_SIZE,
  DEEZER_SEEDS,
} from './deezer.ts';
import { dispatcher } from './dispatcher.ts';
import { MissingConfigError, RefusedError } from './errors.ts';
import { getSongBpm } from './getsongbpm.ts';
import { DEEZER, GETSONGBPM, RECCOBEATS, SPOTIFY } from './policies.ts';
import { reccoBeats } from './reccobeats.ts';
import { reports } from './reports.ts';
import { featureChecks, spotifyJobs } from './scheduler.ts';
import { collectorServer } from './server.ts';
import { spotify } from './spotify.ts';
import { SECOND_MS } from './upstream.ts';

const GETSONGBPM_PERIOD_MS = 7 * DAY_MS;
const DEEZER_PERIOD_MS = 14 * DAY_MS;
const IDLE_MS = 60 * SECOND_MS;
// A refusal is rechecked at least this often, so an operator's unblock applies within a minute.
const REFUSED_POLL_MS = 60 * SECOND_MS;
const ERROR_PAUSE_MS = 10 * SECOND_MS;
const STALLED_MS = 2 * 60 * SECOND_MS;

function loadConfig(): Config {
  try {
    return collectorConfig(process.env);
  } catch (err) {
    if (!(err instanceof MissingConfigError)) {
      throw err;
    }
    console.error(`${err.message}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const config = loadConfig();
const clock = systemClock;
const db = openWriter(config.catalogPath);
const t = transitions(db);
const received = reports(db);
let tickedAt = clock.monotonic();

/** Runs `step` forever, resting while it has nothing to do or its service refuses calls. */
async function loop(name: string, step: () => Promise<unknown>) {
  for (;;) {
    tickedAt = clock.monotonic();
    try {
      if (!(await step())) {
        await clock.sleep(IDLE_MS);
      }
    } catch (err) {
      if (err instanceof RefusedError) {
        await clock.sleep(Math.min(Math.max(err.until - clock.now(), SECOND_MS), REFUSED_POLL_MS));
        continue;
      }
      console.error(`${name}:`, err);
      await clock.sleep(ERROR_PAUSE_MS);
    }
  }
}

const getSongBpmCalls = dispatcher(db, GETSONGBPM, clock);
const tempo = getSongBpm(config.getSongBpmApiKey, getSongBpmCalls);
const sources: CrawlSource[] = [
  {
    name: 'getsongbpm',
    bit: SOURCE_GETSONGBPM,
    periodMs: GETSONGBPM_PERIOD_MS,
    items: crawlOrder().map((bpm) => ({ bpm, seed: '' })),
    page: async ({ bpm }) => ({ songs: await tempo(bpm), next: null }),
  },
];
if (config.deezer) {
  const search = deezer(dispatcher(db, DEEZER, clock));
  sources.push({
    name: 'deezer',
    bit: SOURCE_DEEZER,
    periodMs: DEEZER_PERIOD_MS,
    items: crawlOrder(DEEZER_MIN_BPM, DEEZER_MAX_BPM).flatMap((bpm) => DEEZER_SEEDS.map((seed) => ({ bpm, seed }))),
    page: async ({ bpm, seed }, index) => {
      const { songs, rows } = await search(bpm, seed, index);
      const last = rows < DEEZER_PAGE_SIZE || index >= DEEZER_MAX_INDEX;
      return { songs, next: last ? null : index + DEEZER_PAGE_SIZE };
    },
  });
}
for (const source of sources) {
  void loop(source.name, crawler(db, t, source, clock).step);
}

const spotifyCalls = dispatcher(db, SPOTIFY, clock);
const lookup = spotify({ clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret }, spotifyCalls);
const jobs = spotifyJobs(db, {
  market: config.market,
  transitions: t,
  spotify: lookup,
  calls: spotifyCalls,
  clock,
  suspects: received.suspects,
});
void loop('spotify', jobs.step);

if (config.reccoBeats) {
  const checks = featureChecks(db, t, reccoBeats(dispatcher(db, RECCOBEATS, clock)), clock);
  void loop('reccobeats', checks.step);
}

const healthy = () => clock.monotonic() - tickedAt < STALLED_MS;
collectorServer(received, healthy).listen(config.port, () => {
  console.log(`collector for market ${config.market} listening on port ${config.port}`);
});
