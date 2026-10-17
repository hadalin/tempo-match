import { UpstreamError } from './errors.ts';

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
