export class InvalidBpmError extends Error {
  constructor(bpm: number, min: number, max: number) {
    super(`BPM must be a whole number from ${min} to ${max}, got ${bpm}`);
    this.name = 'InvalidBpmError';
  }
}

export class NoMatchError extends Error {
  constructor(bpm: number) {
    super(`No song at ${bpm} BPM could be found on Spotify`);
    this.name = 'NoMatchError';
  }
}

export class UpstreamError extends Error {
  constructor(service: string, failure: number | Error) {
    if (typeof failure === 'number') {
      super(`${service} request failed with HTTP ${failure}`);
    } else {
      super(`${service} request failed: ${failure.message}`, { cause: failure });
    }
    this.name = 'UpstreamError';
  }
}

export class MissingConfigError extends Error {
  constructor(names: string[]) {
    super(`Missing environment variables: ${names.join(', ')}`);
    this.name = 'MissingConfigError';
  }
}

export class NoLuckyPickError extends Error {
  constructor() {
    super("Couldn't find a lucky song, try again");
    this.name = 'NoLuckyPickError';
  }
}

export class LuckyDisabledError extends Error {
  constructor() {
    super("I'm feeling lucky is turned off on this server");
    this.name = 'LuckyDisabledError';
  }
}
