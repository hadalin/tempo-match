export interface Call {
  url: URL;
  init: RequestInit | undefined;
}

export type Route = (
  url: URL,
  init: RequestInit | undefined,
) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fakeFetch(route: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const res = await route(url, init);
    if (!res) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return res;
  };
  return { fetch: fn as typeof fetch, calls };
}
