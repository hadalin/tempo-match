export class UpstreamError extends Error {
  constructor(service: string, failure: number | Error | string) {
    if (typeof failure === 'number') {
      super(`${service} request failed with HTTP ${failure}`);
    } else if (typeof failure === 'string') {
      super(`${service} request failed: ${failure}`);
    } else {
      super(`${service} request failed: ${failure.message}`, { cause: failure });
    }
    this.name = 'UpstreamError';
  }
}

/** Whether text is an UpstreamError message: a hold with one was stored by a failure, not an operator. */
export function isUpstreamFailure(text: string): boolean {
  return / request failed( with HTTP \d+$|: )/.test(text);
}

/** A network error, a timeout, a 5xx or a quota error: retried after a growing back-off. */
export class UnavailableError extends UpstreamError {
  constructor(service: string, failure: number | Error | string) {
    super(service, failure);
    this.name = 'UnavailableError';
  }
}

export class RateLimitedError extends UpstreamError {
  readonly retryAfter: string | null;

  constructor(service: string, retryAfter: string | null) {
    super(service, 429);
    this.retryAfter = retryAfter;
    this.name = 'RateLimitedError';
  }
}

/** 401, 403 or refused credentials: no call until an operator unblocks the service. */
export class UnauthorizedError extends UpstreamError {
  /** The HTTP status, or null when the failure was refused credentials. */
  readonly status: number | null;

  constructor(service: string, failure: number | Error) {
    super(service, failure);
    this.status = typeof failure === 'number' ? failure : null;
    this.name = 'UnauthorizedError';
  }
}

/** A response the collector cannot trust: no call until an operator unblocks the service. */
export const RESPONSE_FORMAT = 'response format';

export class ResponseFormatError extends UpstreamError {
  constructor(service: string, problem: string) {
    super(service, `${RESPONSE_FORMAT}: ${problem}`);
    this.name = 'ResponseFormatError';
  }
}

/** Thrown instead of a call while the service is banned, held or out of its daily calls. */
export class RefusedError extends Error {
  readonly until: number;

  constructor(service: string, until: number, reason: string) {
    super(`${service} calls refused until ${new Date(until).toISOString()}: ${reason}`);
    this.until = until;
    this.name = 'RefusedError';
  }
}

export class MissingConfigError extends Error {
  constructor(names: string[]) {
    super(`Missing environment variables: ${names.join(', ')}`);
    this.name = 'MissingConfigError';
  }
}

/**
 * Whether a call that failed this way can succeed later: the dispatcher stored a ban or a hold,
 * or refused to send. Other failures, such as a 400, would repeat on every attempt.
 */
export function retriesLater(err: unknown): boolean {
  return [RefusedError, RateLimitedError, UnavailableError, UnauthorizedError, ResponseFormatError].some(
    (type) => err instanceof type,
  );
}
