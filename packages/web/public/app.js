const form = document.getElementById('form');
const slider = document.getElementById('bpm');
const value = document.getElementById('value');
const submit = document.getElementById('submit');
const lucky = document.getElementById('lucky');
const result = document.getElementById('result');
const SPOTIFY_ID = /^[A-Za-z0-9]+$/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SPOTIFY_GREEN = '#1ed760';
const TOO_MANY_REQUESTS = 429;
const DEFAULT_RETRY_SECONDS = 10;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 120;
const SECOND_MS = 1000;
const DELTA_SECONDS = /^\d+$/;
const WHOLE_NUMBER = /^\d+$/;
const MIN_START_BPM = 80;
const MAX_START_BPM = 130;
const IOS_DEVICE = /\b(iPhone|iPad|iPod)\b/;
const IPAD_DESKTOP_PLATFORM = 'MacIntel';
const SPOTIFY_ICON_VIEWBOX = '0 0 236.05 225.25';
// Path copied unmodified from Spotify's official icon (Primary_Logo_Green_RGB.svg).
const SPOTIFY_ICON_PATH = 'm122.37,3.31C61.99.91,11.1,47.91,8.71,108.29c-2.4,60.38,44.61,111.26,104.98,113.66,60.38,2.4,111.26-44.6,113.66-104.98C229.74,56.59,182.74,5.7,122.37,3.31Zm46.18,160.28c-1.36,2.4-4.01,3.6-6.59,3.24-.79-.11-1.58-.37-2.32-.79-14.46-8.23-30.22-13.59-46.84-15.93-16.62-2.34-33.25-1.53-49.42,2.4-3.51.85-7.04-1.3-7.89-4.81-.85-3.51,1.3-7.04,4.81-7.89,17.78-4.32,36.06-5.21,54.32-2.64,18.26,2.57,35.58,8.46,51.49,17.51,3.13,1.79,4.23,5.77,2.45,8.91Zm14.38-28.72c-2.23,4.12-7.39,5.66-11.51,3.43-16.92-9.15-35.24-15.16-54.45-17.86-19.21-2.7-38.47-1.97-57.26,2.16-1.02.22-2.03.26-3.01.12-3.41-.48-6.33-3.02-7.11-6.59-1.01-4.58,1.89-9.11,6.47-10.12,20.77-4.57,42.06-5.38,63.28-2.4,21.21,2.98,41.46,9.62,60.16,19.74,4.13,2.23,5.66,7.38,3.43,11.51Zm15.94-32.38c-2.1,4.04-6.47,6.13-10.73,5.53-1.15-.16-2.28-.52-3.37-1.08-19.7-10.25-40.92-17.02-63.07-20.13-22.15-3.11-44.42-2.45-66.18,1.97-5.66,1.15-11.17-2.51-12.32-8.16-1.15-5.66,2.51-11.17,8.16-12.32,24.1-4.89,48.74-5.62,73.25-2.18,24.51,3.44,47.99,10.94,69.81,22.29,5.12,2.66,7.11,8.97,4.45,14.09Z';

// Safari blocks third-party cookies in iframes, so the embed plays only previews on every iOS browser.
const previewOnlyDevice = iosDevice();

function iosDevice() {
  const match = navigator.userAgent.match(IOS_DEVICE);
  if (match) {
    return match[1];
  }
  if (navigator.platform === IPAD_DESKTOP_PLATFORM && navigator.maxTouchPoints > 1) {
    return 'iPad';
  }
  return null;
}

function setBpm(bpm) {
  const clamped = Math.min(Math.max(Math.round(bpm), slider.min), slider.max);
  slider.value = clamped;
  value.value = clamped;
}

function enteredBpm() {
  const text = value.value.trim();
  const bpm = text === '' ? NaN : Number(text);
  return Number.isFinite(bpm) ? bpm : Number(slider.value);
}

const urlBpm = new URLSearchParams(location.search).get('bpm');
if (WHOLE_NUMBER.test(urlBpm ?? '')) {
  setBpm(Number(urlBpm));
} else {
  setBpm(MIN_START_BPM + Math.floor(Math.random() * (MAX_START_BPM - MIN_START_BPM + 1)));
}
form.className = '';

slider.addEventListener('input', () => { value.value = slider.value; });
value.addEventListener('change', () => { setBpm(enteredBpm()); });
value.addEventListener('focus', () => { value.select(); });
document.getElementById('down').addEventListener('click', () => { setBpm(Number(slider.value) - 1); });
document.getElementById('up').addEventListener('click', () => { setBpm(Number(slider.value) + 1); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) {
    return;
  }

  setBpm(enteredBpm());
  await search(`/api/song?bpm=${slider.value}`);
});

lucky.addEventListener('click', async () => {
  if (lucky.disabled) {
    return;
  }

  const song = await search(`/api/song?lucky=1&exclude=${slider.value}`);
  if (song) {
    setBpm(song.bpm);
  }
});

async function search(url) {
  disableSearch();
  result.replaceChildren();
  let song;
  try {
    const res = await fetch(url);
    if (res.status === TOO_MANY_REQUESTS) {
      startCooldown(retrySeconds(res.headers.get('Retry-After')));
      return;
    }

    const body = await res.json();
    if (!res.ok) {
      showError(body.error);
    } else if (showSong(body)) {
      song = body;
    }
  } catch {
    showError('Could not reach the server');
  }
  enableSearch();
  return song;
}

function disableSearch() {
  submit.disabled = true;
  lucky.disabled = true;
}

function enableSearch() {
  submit.disabled = false;
  lucky.disabled = false;
}

function retrySeconds(header) {
  const seconds = parseRetryAfter(header?.trim() ?? '');
  if (!Number.isFinite(seconds)) {
    return DEFAULT_RETRY_SECONDS;
  }
  return Math.min(Math.max(seconds, MIN_RETRY_SECONDS), MAX_RETRY_SECONDS);
}

function parseRetryAfter(header) {
  if (DELTA_SECONDS.test(header)) {
    return Number(header);
  }
  return Math.ceil((Date.parse(header) - Date.now()) / SECOND_MS);
}

function startCooldown(seconds) {
  const deadline = Date.now() + seconds * SECOND_MS;
  const countdown = document.createElement('span');
  countdown.setAttribute('aria-hidden', 'true');
  const announcement = document.createElement('span');
  announcement.className = 'visually-hidden';
  announcement.textContent = `Too many searches, try again in ${seconds} seconds`;
  const notice = document.createElement('p');
  notice.className = 'error';
  notice.append(countdown, announcement);
  result.append(notice);

  const tick = () => {
    const left = Math.ceil((deadline - Date.now()) / SECOND_MS);
    if (left > 0) {
      countdown.textContent = `Too many searches, try again in ${left} s`;
      return;
    }
    clearInterval(timer);
    enableSearch();
    const done = document.createElement('p');
    done.className = 'visually-hidden';
    done.textContent = 'You can search again';
    result.replaceChildren(done);
  };
  const timer = setInterval(tick, SECOND_MS);
  tick();
}

function showSong(song) {
  const trackId = song.spotifyTrackId;
  if (!SPOTIFY_ID.test(trackId)) {
    showError('Spotify returned an unexpected track');
    return false;
  }

  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  title.textContent = song.title;
  const meta = document.createElement('p');
  meta.textContent = `${song.artist} · ${song.bpm} BPM`;

  const embed = document.createElement('iframe');
  embed.src = `https://open.spotify.com/embed/track/${trackId}`;
  embed.title = `Spotify player: ${song.title}`;
  embed.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  embed.loading = 'lazy';
  const play = document.createElement('a');
  play.className = 'play';
  play.href = `spotify:track:${trackId}`;
  play.append(spotifyIcon(), 'Play on Spotify');
  const web = document.createElement('a');
  web.className = 'web';
  web.href = `https://open.spotify.com/track/${trackId}`;
  web.target = '_blank';
  web.rel = 'noopener';
  web.textContent = 'or open in web player';

  card.append(title, meta, embed);
  if (previewOnlyDevice) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = `Previews only on ${previewOnlyDevice}. Full song: Play on Spotify.`;
    card.append(hint);
  }
  card.append(play, web);
  result.append(card);
  return true;
}

function spotifyIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', SPOTIFY_ICON_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', SPOTIFY_GREEN);
  path.setAttribute('d', SPOTIFY_ICON_PATH);
  svg.append(path);
  return svg;
}

function showError(message) {
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = message;
  result.append(p);
}
