import { engineFromEnv, MissingConfigError, type TempoEngine } from '@tempo-match/collector';
import { fixedWindow, InvalidRateLimitError, parseRateLimit, type RateLimiter } from './rate-limit.ts';
import { webServer } from './server.ts';

const DEFAULT_PORT = 3000;

function loadEngine(): TempoEngine {
  try {
    return engineFromEnv(process.env);
  } catch (err) {
    if (!(err instanceof MissingConfigError)) {
      throw err;
    }
    console.error(`${err.message}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

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

const port = Number(process.env.PORT) || DEFAULT_PORT;
webServer(loadEngine(), loadRateLimiter()).listen(port, () => {
  console.log(`tempo-match listening on http://localhost:${port}`);
});
