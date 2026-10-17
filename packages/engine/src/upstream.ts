import { UpstreamError } from './errors.ts';

export const SECOND_MS = 1000;
const DELTA_SECONDS = /^\d+$/;

/** Like fetchFn, but rejects with UpstreamError when the service cannot be reached in time. */
export async function fetchUpstream(
  service: string,
  fetchFn: typeof fetch,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(input, init);
  } catch (err) {
    // fetch rejects only with a TypeError or an abort DOMException, both Errors.
    throw new UpstreamError(service, err as Error);
  }
}

/** Milliseconds to wait for a Retry-After of delta seconds or an HTTP date, within 0 to maxMs. */
export function retryAfterMs(
  header: string | null,
  now: number,
  fallbackMs: number,
  maxMs: number,
): number {
  const value = header?.trim() ?? '';
  const ms = DELTA_SECONDS.test(value) ? Number(value) * SECOND_MS : Date.parse(value) - now;
  if (Number.isNaN(ms)) {
    return fallbackMs;
  }
  return Math.min(Math.max(ms, 0), maxMs);
}
