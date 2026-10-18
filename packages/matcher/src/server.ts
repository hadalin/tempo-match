import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BusyError,
  InvalidBpmError,
  LuckyDisabledError,
  MAX_BPM,
  MIN_BPM,
  NoLuckyPickError,
  NoMatchError,
  UpstreamError,
  type MatchedSong,
  type TempoEngine,
} from '@tempo-match/collector';
import { contentVersion, versionUrls } from './asset-version.ts';
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
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

function readPublic(file: string): Buffer {
  return readFileSync(new URL(`../public/${file}`, import.meta.url));
}

export function webServer(engine: TempoEngine, rateLimiter?: RateLimiter): Server {
  return createServer(async (req, res) => {
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

    if (req.method === 'GET' && url.pathname === '/api/song') {
      const retryAfter = rateLimiter?.();
      if (retryAfter !== undefined) {
        send(res, HTTP_TOO_MANY_REQUESTS, HTML, RATE_LIMITED_PAGE, { 'Retry-After': String(retryAfter) });
        return;
      }

      const market = visitorMarket(req);
      const song = url.searchParams.get('lucky') === '1'
        ? engine.luckySong(market, excludeBpm(url.searchParams.get('exclude')))
        : engine.matchSong(bpmParam(url.searchParams.get('bpm')), market);
      await sendSong(song, res);
      return;
    }

    sendJson(res, HTTP_NOT_FOUND, { error: 'Not found' });
  });
}

function bpmParam(param: string | null): number {
  return param !== null && WHOLE_NUMBER.test(param) ? Number(param) : NaN;
}

function excludeBpm(param: string | null): number | undefined {
  const bpm = bpmParam(param);
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : undefined;
}

function visitorMarket(req: IncomingMessage): string | undefined {
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

async function sendSong(song: Promise<MatchedSong>, res: ServerResponse): Promise<void> {
  try {
    sendJson(res, HTTP_OK, await song);
  } catch (err) {
    const { status, message } = errorResponse(err);
    if (status >= HTTP_INTERNAL_ERROR && !(err instanceof BusyError)) {
      console.error(err);
    }
    sendJson(res, status, { error: message });
  }
}

function errorResponse(err: unknown): { status: number; message: string } {
  if (err instanceof InvalidBpmError) {
    return { status: HTTP_BAD_REQUEST, message: err.message };
  }
  if (err instanceof NoMatchError || err instanceof NoLuckyPickError) {
    return { status: HTTP_NOT_FOUND, message: err.message };
  }
  if (err instanceof LuckyDisabledError || err instanceof BusyError) {
    return { status: HTTP_SERVICE_UNAVAILABLE, message: err.message };
  }
  if (err instanceof UpstreamError) {
    return { status: HTTP_BAD_GATEWAY, message: 'A music service is unavailable, try again later' };
  }
  return { status: HTTP_INTERNAL_ERROR, message: 'Something went wrong' };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON_TYPE, JSON.stringify(body));
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
