import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { fakeDocument, type FakeElement, type FakeFrameWindow } from './fake-dom.ts';

const EMBED_SOURCE = await readFile(new URL('../public/spotify-embed.js', import.meta.url), 'utf8');
const APP_SOURCE = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const IDS = ['form', 'bpm', 'value', 'submit', 'autoplay', 'autoplay-tip', 'result', 'down', 'up'];
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
const SPOTIFY = 'https://open.spotify.com';
const PREVIEW_MS = 29713;
const FULL_TRACK_MS = 215000;
const READY_TIMEOUT_MS = 10000;
const PLAY_TIMEOUT_MS = 5000;
const TOOLTIP_AFTER_TAP_MS = 1500;

function tooMany(headers: Record<string, string> = {}): Response {
  return new Response(CLOUDFLARE_PAGE, { status: 429, headers: { 'Content-Type': 'text/html', ...headers } });
}

type FakeNavigator = typeof DESKTOP_MAC;
type MessageListener = (event: { origin: string; source: unknown; data: unknown }) => void;

class FakeWindow {
  private listeners = new Set<MessageListener>();

  addEventListener(_: string, listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_: string, listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  message(source: unknown, data: unknown, origin = SPOTIFY): void {
    for (const listener of [...this.listeners]) {
      listener({ origin, source, data });
    }
  }
}

class MemoryStorage {
  items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const BLOCKED_STORAGE = {
  getItem(): never {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem(): never {
    throw new DOMException('denied', 'SecurityError');
  },
};

function loadApp(
  fetch: (url: string) => Promise<Response>,
  search = '',
  navigator: FakeNavigator = DESKTOP_MAC,
  localStorage: MemoryStorage | typeof BLOCKED_STORAGE = new MemoryStorage(),
) {
  const document = fakeDocument(IDS);
  const element = (id: string) => document.elements.get(id) as FakeElement;
  Object.assign(element('bpm'), { min: '40', max: '220', value: '120' });
  element('value').value = '120';
  element('form').className = 'loading';
  const window = new FakeWindow();
  new Function('document', 'fetch', 'location', 'navigator', 'window', 'localStorage', `${EMBED_SOURCE}\n${APP_SOURCE}`)(
    document, fetch, { search }, navigator, window, localStorage,
  );
  return {
    window,
    form: element('form'),
    submit: element('submit'),
    autoplay: element('autoplay'),
    tip: element('autoplay-tip'),
    result: element('result'),
    slider: element('bpm'),
    value: element('value'),
  };
}

function card(result: FakeElement): FakeElement {
  return result.children[0] as FakeElement;
}

function embed(result: FakeElement): FakeElement {
  return card(result).children[2] as FakeElement;
}

function autoplayNotes(result: FakeElement): string[] {
  return card(result).children
    .filter((child): child is FakeElement => typeof child !== 'string' && child.className === 'autoplay-note')
    .map((note) => note.textContent);
}

function announcements(result: FakeElement): string[] {
  return result.children
    .filter((child): child is FakeElement => typeof child !== 'string' && child.className === 'visually-hidden')
    .map((announcement) => announcement.textContent);
}

function icons(button: FakeElement): (string | null)[] {
  return (button.children as FakeElement[]).map((icon) => icon.getAttribute('class'));
}

function commands(frame: FakeElement): unknown[] {
  return (frame.contentWindow as FakeFrameWindow).messages.map((sent) => (sent as { message: { command: string } }).message.command);
}

function playbackUpdate(position: number, { isPaused = false, duration = PREVIEW_MS } = {}) {
  return { type: 'playback_update', payload: { isPaused, isBuffering: false, duration, position, playingURI: 'spotify:track:1' } };
}

function emit(app: ReturnType<typeof loadApp>, ...messages: unknown[]): void {
  const frame = embed(app.result);
  for (const message of messages) {
    app.window.message(frame.contentWindow, message);
  }
}

function playOut(app: ReturnType<typeof loadApp>, duration = PREVIEW_MS): void {
  emit(app, { type: 'ready' }, playbackUpdate(duration - 2100, { duration }), playbackUpdate(duration - 1050, { duration }),
    playbackUpdate(duration, { duration }), playbackUpdate(duration, { duration }));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function cycleTo(app: ReturnType<typeof loadApp>, clicks: number): Promise<void> {
  for (let click = 0; click < clicks; click++) {
    await app.autoplay.dispatch('click');
  }
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
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOW });
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

const AUTOPLAY_STATES = [
  { tip: 'Autoplay off', ariaLabel: 'Autoplay: off. Click to autoplay same tempo', announced: 'Autoplay off', icons: [null] },
  { tip: 'Autoplay: same tempo', ariaLabel: 'Autoplay: same tempo. Click to autoplay random tempo', announced: 'Autoplay same tempo', icons: [null] },
  { tip: 'Autoplay: random tempo', ariaLabel: 'Autoplay: random tempo. Click to turn autoplay off', announced: 'Autoplay random tempo', icons: [null, 'dice'] },
] as const;

test('starts with autoplay off', () => {
  const app = loadApp(async () => Response.json(SONG));

  assert.equal(app.tip.textContent, 'Autoplay off');
  assert.equal(app.tip.className, '');
  assert.equal(app.autoplay.getAttribute('aria-label'), 'Autoplay: off. Click to autoplay same tempo');
  assert.equal(app.autoplay.getAttribute('data-mode'), 'off');
});

test('cycles autoplay off, same tempo, random tempo, and back off, announcing each once', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');

  for (const state of [...AUTOPLAY_STATES.slice(1), AUTOPLAY_STATES[0]]) {
    await cycleTo(app, 1);

    assert.equal(app.tip.textContent, state.tip);
    assert.equal(app.autoplay.title, '');
    assert.equal(app.autoplay.getAttribute('aria-label'), state.ariaLabel);
    assert.deepEqual(icons(app.autoplay), state.icons);
    assert.deepEqual(announcements(app.result), [state.announced]);
    assert.equal((app.result.children[0] as FakeElement).className, 'card');
  }
});

test('cycles autoplay before any song is found', async () => {
  const app = loadApp(async () => Response.json(SONG));

  await cycleTo(app, 2);

  assert.equal(app.tip.textContent, 'Autoplay: random tempo');
  assert.deepEqual(announcements(app.result), ['Autoplay random tempo']);
});

for (const [clicks, { tip }] of AUTOPLAY_STATES.entries()) {
  test(`remembers ${tip.toLowerCase()} across page loads`, async () => {
    const storage = new MemoryStorage();
    const first = loadApp(async () => Response.json(SONG), '', DESKTOP_MAC, storage);
    await cycleTo(first, clicks);

    const second = loadApp(async () => Response.json(SONG), '', DESKTOP_MAC, storage);

    assert.equal(second.tip.textContent, tip);
  });
}

test('ignores an unknown saved autoplay mode', () => {
  const storage = new MemoryStorage();
  storage.setItem('autoplay', 'shuffle');
  const app = loadApp(async () => Response.json(SONG), '', DESKTOP_MAC, storage);

  assert.equal(app.tip.textContent, 'Autoplay off');
});

test('cycles autoplay when storage is blocked', async () => {
  const app = loadApp(async () => Response.json(SONG), '', DESKTOP_MAC, BLOCKED_STORAGE);

  await cycleTo(app, 1);

  assert.equal(app.tip.textContent, 'Autoplay: same tempo');
});

test('shows the autoplay tooltip briefly after a tap', async () => {
  const app = loadApp(async () => Response.json(SONG));

  await cycleTo(app, 1);
  assert.equal(app.tip.className, 'tooltip shown');
  mock.timers.tick(TOOLTIP_AFTER_TAP_MS - 1);
  assert.equal(app.tip.className, 'tooltip shown');
  mock.timers.tick(1);

  assert.equal(app.tip.className, 'tooltip');
});

test('updates the shown tooltip at once when clicked again', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await cycleTo(app, 1);
  mock.timers.tick(TOOLTIP_AFTER_TAP_MS - 100);

  await cycleTo(app, 1);

  assert.equal(app.tip.textContent, 'Autoplay: random tempo');
  assert.equal(app.tip.className, 'tooltip shown');
  mock.timers.tick(TOOLTIP_AFTER_TAP_MS - 1);
  assert.equal(app.tip.className, 'tooltip shown');
});

for (const leave of ['mouseleave', 'blur']) {
  test(`hides the autoplay tooltip on ${leave}`, async () => {
    const app = loadApp(async () => Response.json(SONG));
    await cycleTo(app, 1);

    await app.autoplay.dispatch(leave);

    assert.equal(app.tip.className, 'tooltip');
  });
}

test('does nothing when a song ends with autoplay off', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');

  playOut(app);
  await settle();

  assert.equal(fetch.mock.callCount(), 1);
});

for (const [kind, duration] of [['preview', PREVIEW_MS], ['full track', FULL_TRACK_MS]] as const) {
  test(`fetches exactly one next song when a ${kind} plays out`, async () => {
    const fetch = mock.fn(async (_: string) => Response.json(SONG));
    const app = loadApp(fetch);
    await app.form.dispatch('submit');
    await cycleTo(app, 1);

    playOut(app, duration);
    await settle();

    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(fetch.mock.calls[1].arguments[0], '/api/song?bpm=120');
  });
}

test('does not advance when the song is paused midway', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' }, playbackUpdate(10000), playbackUpdate(11050), playbackUpdate(11200, { isPaused: true }));
  await settle();

  assert.equal(fetch.mock.callCount(), 1);
});

test('does not advance when the song is seeked to its end', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' }, playbackUpdate(8411), playbackUpdate(PREVIEW_MS), playbackUpdate(PREVIEW_MS), playbackUpdate(PREVIEW_MS));
  await settle();

  assert.equal(fetch.mock.callCount(), 1);
});

test('advances when a song seeked near its end plays out', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' }, playbackUpdate(5000), playbackUpdate(PREVIEW_MS - 900), playbackUpdate(PREVIEW_MS));
  await settle();

  assert.equal(fetch.mock.callCount(), 2);
});

test('advances when a song paused near its end is resumed and plays out', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' }, playbackUpdate(PREVIEW_MS - 1200), playbackUpdate(PREVIEW_MS - 1000, { isPaused: true }),
    playbackUpdate(PREVIEW_MS - 1000), playbackUpdate(PREVIEW_MS));
  await settle();

  assert.equal(fetch.mock.callCount(), 2);
});

test('picks a random song and tempo when a song ends with random-tempo autoplay', async () => {
  const fetch = mock.fn(async (url: string) => Response.json(url.includes('lucky') ? LUCKY_SONG : SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 2);

  playOut(app);
  await settle();

  assert.equal(fetch.mock.calls[1].arguments[0], '/api/song?lucky=1&exclude=120');
  assert.equal(String(app.slider.value), '97');
  assert.match(card(app.result).textContent, /Lucky.*Artist · 97 BPM/);
});

test('plays the next song once its embed is ready', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');
  await cycleTo(app, 1);
  const first = embed(app.result);

  playOut(app);
  await settle();
  const next = embed(app.result);
  assert.notEqual(next, first);
  assert.deepEqual(commands(next), []);
  emit(app, { type: 'ready' });

  assert.deepEqual(commands(next), ['load_complete_ack', 'play']);
  assert.equal((next.contentWindow as FakeFrameWindow).messages.every((sent) => (sent as { targetOrigin: string }).targetOrigin === SPOTIFY), true);
});

test('does not play the first song by itself', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' });

  assert.deepEqual(commands(embed(app.result)), ['load_complete_ack']);
});

test('does not play the found song with autoplay off', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');

  emit(app, { type: 'ready' });

  assert.deepEqual(commands(embed(app.result)), ['load_complete_ack']);
});

for (const [mode, clicks] of [['same tempo', 1], ['random tempo', 2]] as const) {
  test(`plays the found song with ${mode} autoplay`, async () => {
    const fetch = mock.fn(async (_: string) => Response.json(SONG));
    const app = loadApp(fetch);
    await cycleTo(app, clicks);
    await app.form.dispatch('submit');

    emit(app, { type: 'ready' });

    assert.equal(fetch.mock.calls[0].arguments[0], '/api/song?bpm=120');
    assert.deepEqual(commands(embed(app.result)), ['load_complete_ack', 'play']);
  });
}

test('does not play when the search fails with autoplay on', async () => {
  const message = 'No song found at 120 BPM';
  const app = loadApp(async () => Response.json({ error: message }, { status: 404 }));
  await cycleTo(app, 1);
  await app.form.dispatch('submit');

  assert.equal(app.result.textContent, message);
});

test('asks for a tap when the browser blocks playing the next song', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');
  await cycleTo(app, 1);
  playOut(app);
  await settle();

  emit(app, { type: 'ready' }, playbackUpdate(0, { isPaused: true }));
  mock.timers.tick(PLAY_TIMEOUT_MS);

  assert.deepEqual(autoplayNotes(app.result), ['Tap play to start the next song']);
});

test('shows no tap hint when the next song starts playing', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');
  await cycleTo(app, 1);
  playOut(app);
  await settle();

  emit(app, { type: 'ready' }, playbackUpdate(0));
  mock.timers.tick(PLAY_TIMEOUT_MS);

  assert.doesNotMatch(card(app.result).textContent, /Tap play/);
});

test('stops autoplay with the countdown when the next song is rate limited', async () => {
  let calls = 0;
  const fetch = mock.fn(async (_: string) => (calls++ === 0 ? Response.json(SONG) : tooMany({ 'Retry-After': '8' })));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);
  const first = embed(app.result).contentWindow;

  playOut(app);
  await settle();
  app.window.message(first, playbackUpdate(PREVIEW_MS - 1000));
  app.window.message(first, playbackUpdate(PREVIEW_MS));
  await settle();

  assert.equal(visibleNotice(app.result), 'Too many searches, try again in 8 s');
  assert.equal(fetch.mock.callCount(), 2);
});

test('stops autoplay with the message when the next song fails', async () => {
  const message = 'No song found at 120 BPM';
  let calls = 0;
  const fetch = mock.fn(async (_: string) => (calls++ === 0 ? Response.json(SONG) : Response.json({ error: message }, { status: 404 })));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  playOut(app);
  await settle();

  assert.equal(app.result.textContent, message);
  assert.equal(fetch.mock.callCount(), 2);
});

test('ignores embed messages from another origin', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);
  const frame = embed(app.result).contentWindow;

  for (const update of [playbackUpdate(PREVIEW_MS - 1000), playbackUpdate(PREVIEW_MS)]) {
    app.window.message(frame, update, 'https://evil.example');
  }
  await settle();

  assert.equal(fetch.mock.callCount(), 1);
});

test('ignores embed messages from another frame', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  for (const update of [playbackUpdate(PREVIEW_MS - 1000), playbackUpdate(PREVIEW_MS)]) {
    app.window.message({}, update);
  }
  await settle();

  assert.equal(fetch.mock.callCount(), 1);
});

test('turns autoplay off quietly when playback updates have an unknown shape', async () => {
  const fetch = mock.fn(async (_: string) => Response.json(SONG));
  const app = loadApp(fetch);
  await app.form.dispatch('submit');
  await cycleTo(app, 1);

  emit(app, { type: 'ready' }, { type: 'playback_update', payload: { paused: false, progress: 1 } });
  playOut(app);
  await settle();

  assert.deepEqual(autoplayNotes(app.result), ['Autoplay unavailable right now']);
  assert.equal(app.autoplay.disabled, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('turns autoplay off quietly when the embed never says it is ready', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');

  await embed(app.result).dispatch('load');
  mock.timers.tick(READY_TIMEOUT_MS);

  assert.deepEqual(autoplayNotes(app.result), ['Autoplay unavailable right now']);
  assert.equal(app.autoplay.disabled, true);
});

test('keeps autoplay unavailable for later songs', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');
  emit(app, { type: 'playback_update', payload: null });

  await app.form.dispatch('submit');

  assert.deepEqual(autoplayNotes(app.result), ['Autoplay unavailable right now']);
  assert.equal(app.autoplay.disabled, true);
  assert.match(card(app.result).textContent, /Song.*Play on Spotify/);
});

test('waits for the embed ready message after it loads', async () => {
  const app = loadApp(async () => Response.json(SONG));
  await app.form.dispatch('submit');

  await embed(app.result).dispatch('load');
  emit(app, { type: 'ready' });
  mock.timers.tick(READY_TIMEOUT_MS);

  assert.deepEqual(autoplayNotes(app.result), []);
  assert.equal(app.autoplay.disabled, false);
});
