import {
  RateLimitedError,
  UnauthorizedError,
  UnavailableError,
  UpstreamError,
} from './errors.ts';

export const SECOND_MS = 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const DELTA_SECONDS = /^\d+$/;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** Like fetchFn with a timeout, but rejects with the UpstreamError subclass that fits the failure. */
export async function request(
  service: string,
  fetchFn: typeof fetch,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // fetch rejects only with a TypeError or an abort DOMException, both Errors.
    throw new UnavailableError(service, err as Error);
  }

  if (res.ok) {
    return res;
  }
  if (res.status === HTTP_TOO_MANY_REQUESTS) {
    throw new RateLimitedError(service, res.headers.get('Retry-After'));
  }
  if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
    throw new UnauthorizedError(service, res.status);
  }
  if (res.status >= HTTP_SERVER_ERROR) {
    throw new UnavailableError(service, res.status);
  }
  throw new UpstreamError(service, res.status);
}

/** Milliseconds to wait for a Retry-After of delta seconds or an HTTP date, or fallbackMs. */
export function retryAfterMs(header: string | null, now: number, fallbackMs: number): number {
  const value = header?.trim() ?? '';
  const ms = DELTA_SECONDS.test(value) ? Number(value) * SECOND_MS : Date.parse(value) - now;
  if (Number.isNaN(ms)) {
    return fallbackMs;
  }
  return Math.max(ms, 0);
}
