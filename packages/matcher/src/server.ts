import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DAY_MS, isTrackId, MAX_BPM, MIN_BPM, type Counter, type ServedSong } from '@tempo-match/catalog';
import { contentVersion, versionUrls } from './asset-version.ts';
import type { CatalogReader } from './catalog-reader.ts';
import { ipPrefix, type Counters, type Flags } from './flags.ts';
import type { RateLimiter } from './rate-limit.ts';

const HTML = 'text/html; charset=utf-8';
const JAVASCRIPT = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const SVG = 'image/svg+xml';
const PNG = 'image/png';
const JSON_TYPE = 'application/json';
// Cloudflare answers a rate-limited request with an HTML page, so clients must not expect JSON.
const RATE_LIMITED_PAGE = '<!doctype html><title>Too many requests</title><h1>Too many requests</h1>';

const ASSETS = new Map(
  [
    ['/app.js', 'app.js', JAVASCRIPT],
    ['/spotify-embed.js', 'spotify-embed.js', JAVASCRIPT],
    ['/theme.css', 'theme.css', CSS],
    ['/favicon.svg', 'favicon.svg', SVG],
    ['/favicon-32.png', 'favicon-32.png', PNG],
    ['/apple-touch-icon.png', 'apple-touch-icon.png', PNG],
    ['/og-image.png', 'og-image.png', PNG],
  ].map(([path, file, type]) => {
    const body = readPublic(file);
    return [path, { type, body, version: contentVersion(body) }];
  }),
);

const ASSET_VERSIONS = new Map([...ASSETS].map(([path, { version }]) => [path, version]));

const PAGES = new Map(
  [
    ['/', 'index.html'],
    ['/privacy', 'privacy.html'],
    ['/terms', 'terms.html'],
    ['/faq', 'faq.html'],
  ].map(([path, file]) => [path, versionUrls(readPublic(file).toString(), ASSET_VERSIONS)]),
);

const PAGE_CACHE = 'no-cache';
const VERSIONED_ASSET_CACHE = 'public, max-age=31536000, immutable';
const UNVERSIONED_ASSET_CACHE = 'public, max-age=300';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  'frame-src https://open.spotify.com',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const API_PREFIX = '/api/';
const WHOLE_NUMBER = /^\d+$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
// Cloudflare's code for an IP it cannot place; its Tor code T1 already fails COUNTRY_CODE.
const UNKNOWN_COUNTRY = 'XX';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

// The collector fills every BPM Deezer covers, so an empty one there is a gap that closes soon.
const FILLED_MIN_BPM = 60;
const FILLED_MAX_BPM = 210;
const EMPTY_RETRY_SECONDS = 60;
const WARMING_UP_RETRY_SECONDS = 5;
const BUSY_RETRY_SECONDS = 1;
// Never a listing BPM, so a lucky pick without an exclude excludes nothing.
const NO_BPM = 0;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_PRIMARY_CODE = 0xff;

function readPublic(file: string): Buffer {
  return readFileSync(new URL(`../public/${file}`, import.meta.url));
}


export interface MatcherOptions {
  catalog: CatalogReader;
  /** The market whose picks every visitor gets. */
  market: string;
  flags: Flags;
  counters: Counters;
  rateLimiter?: RateLimiter;
  now?: () => number;
  random?: () => number;
}

/** Answers every request from the catalog: no upstream calls, no writes, no waiting. */
export function matcherServer(options: MatcherOptions): Server {
  return createServer((req, res) => {
    const url = URL.parse(req.url ?? '/', 'http://localhost');
    if (!url) {
      sendJson(res, HTTP_NOT_FOUND, { error: 'Not found' });
      return;
    }

    if (url.pathname.startsWith(API_PREFIX)) {
      res.setHeader('Cache-Control', 'no-store');
    }

    const page = PAGES.get(url.pathname);
    if (req.method === 'GET' && page) {
      send(res, HTTP_OK, HTML, page, { 'Cache-Control': PAGE_CACHE });
      return;
    }

    const asset = ASSETS.get(url.pathname);
    if (req.method === 'GET' && asset) {
      const cache = url.searchParams.get('v') === asset.version ? VERSIONED_ASSET_CACHE : UNVERSIONED_ASSET_CACHE;
      send(res, HTTP_OK, asset.type, asset.body, { 'Cache-Control': cache });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      answerOrFail(res, options, () => health(res, options));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/song') {
      const retryAfter = options.rateLimiter?.();
      if (retryAfter !== undefined) {
        send(res, HTTP_TOO_MANY_REQUESTS, HTML, RATE_LIMITED_PAGE, { 'Retry-After': String(retryAfter) });
        return;
      }
      answerOrFail(res, options, () => answerSong(req, url, res, options));
      return;
    }

    sendJson(res, HTTP_NOT_FOUND, { error: 'Not found' });
  });
}

function answerOrFail(res: ServerResponse, options: MatcherOptions, answer: () => void): void {
  if (!options.catalog.queries()) {
    const headers = { 'Retry-After': String(WARMING_UP_RETRY_SECONDS) };
    sendJson(res, HTTP_SERVICE_UNAVAILABLE, { error: 'Warming up, try again in a minute' }, headers);
    return;
  }

  try {
    answer();
  } catch (err) {
    if (isBusy(err)) {
      sendJson(res, HTTP_SERVICE_UNAVAILABLE, { error: 'Busy, try again' }, { 'Retry-After': String(BUSY_RETRY_SECONDS) });
      return;
    }
    console.error(err);
    sendJson(res, HTTP_INTERNAL_ERROR, { error: 'Something went wrong' });
  }
}

function health(res: ServerResponse, { catalog, market, now = Date.now }: MatcherOptions): void {
  const { picks, oldestLookedUpAt } = catalog.queries()!.summary(market, now());
  const oldestPickDays = oldestLookedUpAt === null ? null : Math.floor((now() - oldestLookedUpAt) / DAY_MS);
  sendJson(res, HTTP_OK, { market, picks, oldestPickDays });
}

function answerSong(req: IncomingMessage, url: URL, res: ServerResponse, options: MatcherOptions): void {
  const { market, flags, counters, now = Date.now, random = Math.random } = options;
  const queries = options.catalog.queries()!;
  const time = now();
  const country = visitorCountry(req) ?? UNKNOWN_COUNTRY;
  const skip = trackParam(url.searchParams.get('skip'));
  const dead = trackParam(url.searchParams.get('dead'));
  const count = (counter: Counter) => counters.add(country, counter);

  if (dead && queries.isPick(market, dead, time)) {
    count('dead');
    const prefix = ipPrefix(visitorIp(req));
    if (country === market && prefix) {
      flags.flag(dead, prefix, time);
    }
  }

  const excluded = [skip, dead].filter((id) => id !== null);
  let song: ServedSong | null;
  if (url.searchParams.get('lucky') === '1') {
    song = queries.lucky(market, excludeBpm(url.searchParams.get('exclude')) ?? NO_BPM, excluded, time, random());
    if (!song) {
      count('empty');
      sendJson(res, HTTP_NOT_FOUND, { error: 'No song found, try again later' });
      return;
    }
  } else {
    const bpm = bpmParam(url.searchParams.get('bpm'));
    if (!isBpm(bpm)) {
      sendJson(res, HTTP_BAD_REQUEST, { error: `BPM must be a whole number from ${MIN_BPM} to ${MAX_BPM}, got ${bpm}` });
      return;
    }
    song = queries.songAt(market, bpm, excluded, time, random());
    if (!song) {
      count('empty');
      sendEmpty(res, bpm);
      return;
    }
  }

  count(country === market ? 'served' : 'fallback');
  sendJson(res, HTTP_OK, song);
}

function sendEmpty(res: ServerResponse, bpm: number): void {
  if (bpm >= FILLED_MIN_BPM && bpm <= FILLED_MAX_BPM) {
    const error = `No song at ${bpm} BPM right now, try again in a minute`;
    sendJson(res, HTTP_SERVICE_UNAVAILABLE, { error }, { 'Retry-After': String(EMPTY_RETRY_SECONDS) });
    return;
  }
  sendJson(res, HTTP_NOT_FOUND, { error: `No song at ${bpm} BPM yet` });
}

function bpmParam(param: string | null): number {
  return param !== null && WHOLE_NUMBER.test(param) ? Number(param) : NaN;
}

function isBpm(bpm: number): boolean {
  return bpm >= MIN_BPM && bpm <= MAX_BPM;
}

function excludeBpm(param: string | null): number | undefined {
  const bpm = bpmParam(param);
  return isBpm(bpm) ? bpm : undefined;
}

function trackParam(param: string | null): string | null {
  return isTrackId(param) ? param : null;
}

function visitorCountry(req: IncomingMessage): string | undefined {
  const country = req.headers['cf-ipcountry'];
  if (typeof country !== 'string') {
    return undefined;
  }

  const code = country.toUpperCase();
  if (!COUNTRY_CODE.test(code) || code === UNKNOWN_COUNTRY) {
    return undefined;
  }
  return code;
}

// Port 8095 is bound to 127.0.0.1 and only cloudflared reaches it, so Cloudflare's headers hold.
function visitorIp(req: IncomingMessage): string {
  const ip = req.headers['cf-connecting-ip'];
  return typeof ip === 'string' ? ip : (req.socket.remoteAddress ?? '');
}

function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown }).errcode;
  if (typeof code !== 'number') {
    return false;
  }
  const primary = code & SQLITE_PRIMARY_CODE;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON_TYPE, JSON.stringify(body), headers);
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Type': type });
  res.end(body);
}
