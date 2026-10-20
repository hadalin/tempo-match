import { join } from 'node:path';
import { catalogReader } from './catalog-reader.ts';
import { flags, reporter } from './flags.ts';
import { fixedWindow, InvalidRateLimitError, parseRateLimit, type RateLimiter } from './rate-limit.ts';
import { matcherServer } from './server.ts';

const DEFAULT_PORT = 3000;
const DEFAULT_MARKET = 'US';
const CATALOG_FILE = 'catalog.db';
const REPORT_EVERY_MS = 60_000;

function loadRateLimiter(): RateLimiter | undefined {
  const spec = process.env.SIMULATE_RATE_LIMIT;
  if (!spec) {
    return undefined;
  }

  try {
    return fixedWindow(parseRateLimit(spec));
  } catch (err) {
    if (!(err instanceof InvalidRateLimitError)) {
      throw err;
    }
    console.error(err.message);
    process.exit(1);
  }
}

const market = (process.env.SPOTIFY_MARKET || DEFAULT_MARKET).toUpperCase();
const catalog = catalogReader(join(process.env.DATA_DIR || '.', CATALOG_FILE));
const flagged = flags();
const collectorUrl = process.env.COLLECTOR_URL;
if (collectorUrl) {
  const report = reporter(collectorUrl, market, flagged);
  setInterval(() => void report.push(), REPORT_EVERY_MS);
}

const port = Number(process.env.PORT) || DEFAULT_PORT;
const server = matcherServer({ catalog, market, flags: flagged, rateLimiter: loadRateLimiter() });
server.listen(port, () => {
  console.log(`tempo-match listening on http://localhost:${port}`);
});
