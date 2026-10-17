import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { fakeDocument, type FakeElement } from './fake-dom.ts';

const APP_SOURCE = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const IDS = ['form', 'bpm', 'value', 'submit', 'lucky', 'result', 'down', 'up'];
const NOW = Date.UTC(2026, 9, 17, 12);
const SONG = { title: 'Song', artist: 'Artist', bpm: 120, spotifyTrackId: '1' };
const LUCKY_SONG = { title: 'Lucky', artist: 'Artist', bpm: 97, spotifyTrackId: '2' };
// Lands on 120 within 80-130, the start the existing tests expect.
const RANDOM_FOR_120 = 0.79;
const DESKTOP_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
const DESKTOP_CHROME = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
const IPAD = { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPad', maxTouchPoints: 5 };
const IPAD_DESKTOP_MODE = { ...DESKTOP_MAC, maxTouchPoints: 5 };
const CLOUDFLARE_PAGE = '<!DOCTYPE html><title>Rate limited</title>';

function tooMany(headers: Record<string, string> = {}): Response {
  return new Response(CLOUDFLARE_PAGE, { status: 429, headers: { 'Content-Type': 'text/html', ...headers } });
}

type FakeNavigator = typeof DESKTOP_MAC;

function loadApp(fetch: (url: string) => Promise<Response>, search = '', navigator: FakeNavigator = DESKTOP_MAC) {
  const document = fakeDocument(IDS);
  const element = (id: string) => document.elements.get(id) as FakeElement;
  Object.assign(element('bpm'), { min: '40', max: '220', value: '120' });
  element('value').value = '120';
  element('form').className = 'loading';
  new Function('document', 'fetch', 'location', 'navigator', APP_SOURCE)(document, fetch, { search }, navigator);
  return {
    form: element('form'),
    submit: element('submit'),
    lucky: element('lucky'),
    result: element('result'),
    slider: element('bpm'),
    value: element('value'),
  };
}

function previewHint(result: FakeElement): FakeElement | undefined {
  const card = result.children[0] as FakeElement;
  return card.children.find((child): child is FakeElement => typeof child !== 'string' && child.className === 'hint');
}

function visibleNotice(result: FakeElement): string {
  const notice = result.children[0] as FakeElement;
  return (notice.children[0] as FakeElement).textContent;
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  mock.method(Math, 'random', () => RANDOM_FOR_120);
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test('counts down the Retry-After seconds with Find a song disabled', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': '8' }));

  await app.form.dispatch('submit');

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 8 s');
  assert.equal(app.submit.disabled, true);
  mock.timers.tick(3000);
  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 5 s');
  assert.equal(app.submit.disabled, true);
});

test('announces the notice once, without the countdown', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': '8' }));

  await app.form.dispatch('submit');

  const [countdown, announcement] = (app.result.children[0] as FakeElement).children as FakeElement[];
  assert.equal(countdown.getAttribute('aria-hidden'), 'true');
  assert.equal(announcement.textContent, 'Too many searches, try again in 8 seconds');
  assert.doesNotMatch(app.result.textContent, /DOCTYPE|Rate limited/);
});

test('waits until a Retry-After HTTP date', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': new Date(NOW + 30_000).toUTCString() }));

  await app.form.dispatch('submit');

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 30 s');
});

test('waits the default time without Retry-After', async () => {
  const app = loadApp(async () => tooMany());

  await app.form.dispatch('submit');

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 10 s');
});

test('clamps Retry-After to two minutes', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': '3600' }));

  await app.form.dispatch('submit');

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 120 s');
});

test('re-enables Find a song and clears the notice after the countdown', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': '2' }));

  await app.form.dispatch('submit');
  mock.timers.tick(2000);

  assert.equal(app.submit.disabled, false);
  assert.equal(app.result.children.length, 1);
  assert.equal((app.result.children[0] as FakeElement).className, 'visually-hidden');
  assert.equal(app.result.textContent, 'You can search again');
});

test('disables Find a song while a search is in flight', async () => {
  let respond = (_: Response) => {};
  const fetch = mock.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const app = loadApp(fetch);

  const searching = app.form.dispatch('submit');
  assert.equal(app.submit.disabled, true);
  await app.form.dispatch('submit');
  assert.equal(fetch.mock.callCount(), 1);

  respond(Response.json(SONG));
  await searching;
  assert.equal(app.submit.disabled, false);
});

test('re-enables Find a song after a failed search', async () => {
  const app = loadApp(async () => { throw new TypeError('offline'); });

  await app.form.dispatch('submit');

  assert.equal(app.submit.disabled, false);
  assert.equal(app.result.textContent, 'Could not reach the server');
});

test('sets the tempo from a lucky song and shows it', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(LUCKY_SONG));
  const app = loadApp(fetch);

  await app.lucky.dispatch('click');

  assert.equal(fetch.mock.calls[0].arguments[0], '/api/song?lucky=1&exclude=120');
  assert.equal(String(app.value.value), '97');
  assert.equal(String(app.slider.value), '97');
  const card = app.result.children[0] as FakeElement;
  assert.equal(card.className, 'card');
  assert.match(card.textContent, /Lucky.*Artist · 97 BPM/);
  assert.equal(app.lucky.disabled, false);
});

test('keeps the tempo when a lucky pick fails', async () => {
  const message = "Couldn't find a lucky song, try again";
  const app = loadApp(async () => Response.json({ error: message }, { status: 404 }));

  await app.lucky.dispatch('click');

  assert.equal(String(app.value.value), '120');
  assert.equal(app.result.textContent, message);
  assert.equal(app.lucky.disabled, false);
});

test('disables both buttons while either search is in flight', async () => {
  let respond = (_: Response) => {};
  const fetch = mock.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const app = loadApp(fetch);

  const searching = app.lucky.dispatch('click');
  assert.equal(app.submit.disabled, true);
  assert.equal(app.lucky.disabled, true);
  await app.lucky.dispatch('click');
  await app.form.dispatch('submit');
  assert.equal(fetch.mock.callCount(), 1);

  respond(Response.json(LUCKY_SONG));
  await searching;
  assert.equal(app.submit.disabled, false);
  assert.equal(app.lucky.disabled, false);
});

test('counts down a rate-limited lucky pick with both buttons disabled', async () => {
  const app = loadApp(async () => tooMany({ 'Retry-After': '2' }));

  await app.lucky.dispatch('click');

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 2 s');
  assert.equal(app.submit.disabled, true);
  assert.equal(app.lucky.disabled, true);
  mock.timers.tick(2000);
  assert.equal(app.submit.disabled, false);
  assert.equal(app.lucky.disabled, false);
});

test('starts at the bpm given in the page URL', () => {
  const app = loadApp(async () => Response.json(SONG), '?bpm=97');

  assert.equal(String(app.slider.value), '97');
  assert.equal(String(app.value.value), '97');
});

test('clamps a page URL bpm outside 40-220', () => {
  const app = loadApp(async () => Response.json(SONG), '?bpm=999');

  assert.equal(String(app.slider.value), '220');
});

for (const bpm of ['', 'abc', '97.5', '-5', '1e2', '0x61']) {
  test(`ignores a page URL bpm of "${bpm}"`, () => {
    const app = loadApp(async () => Response.json(SONG), `?bpm=${bpm}`);

    assert.equal(String(app.slider.value), '120');
  });
}

for (const [typed, bpm] of [['0', '40'], ['39', '40'], ['221', '220'], ['', '120'], ['  ', '120']]) {
  test(`sets a typed bpm of "${typed}" to ${bpm}`, async () => {
    const app = loadApp(async () => Response.json(SONG));

    app.value.value = typed;
    await app.value.dispatch('change');

    assert.equal(String(app.slider.value), bpm);
    assert.equal(String(app.value.value), bpm);
  });
}

test('searches the lowest bpm when 0 is typed and submitted', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);

  app.value.value = '0';
  await app.form.dispatch('submit');

  assert.equal(fetch.mock.calls[0].arguments[0], '/api/song?bpm=40');
});

test('starts at a random bpm of at least 80 without a page URL bpm', () => {
  mock.method(Math, 'random', () => 0);
  const app = loadApp(async () => Response.json(SONG));

  assert.equal(String(app.slider.value), '80');
  assert.equal(String(app.value.value), '80');
});

test('starts at a random bpm of at most 130 without a page URL bpm', () => {
  mock.method(Math, 'random', () => 0.999999);
  const app = loadApp(async () => Response.json(SONG));

  assert.equal(String(app.slider.value), '130');
  assert.equal(String(app.value.value), '130');
});

test('prefers a page URL bpm over a random start', () => {
  mock.method(Math, 'random', () => 0);
  const app = loadApp(async () => Response.json(SONG), '?bpm=97');

  assert.equal(String(app.slider.value), '97');
});

test('starts at a random bpm for a page URL bpm that is not a whole number', () => {
  mock.method(Math, 'random', () => 0);
  const app = loadApp(async () => Response.json(SONG), '?bpm=abc');

  assert.equal(String(app.slider.value), '80');
});

test('shows the tempo once the start bpm is set', () => {
  const app = loadApp(async () => Response.json(SONG));

  assert.equal(app.form.className, '');
});

for (const [device, navigator, name] of [['an iPhone', IPHONE, 'iPhone'], ['an iPad', IPAD, 'iPad'], ['an iPad in desktop mode', IPAD_DESKTOP_MODE, 'iPad']] as const) {
  test(`tells ${device} that the embed plays previews only`, async () => {
    const app = loadApp(async () => Response.json(SONG), '', navigator);

    await app.form.dispatch('submit');

    assert.equal(previewHint(app.result)?.textContent, `Previews only on ${name}. Full song: Play on Spotify.`);
  });
}

for (const [device, navigator] of [['desktop Safari', DESKTOP_MAC], ['desktop Chrome', DESKTOP_CHROME], ['Android', ANDROID]] as const) {
  test(`shows no preview hint on ${device}`, async () => {
    const app = loadApp(async () => Response.json(SONG), '', navigator);

    await app.form.dispatch('submit');

    assert.equal(previewHint(app.result), undefined);
  });
}
