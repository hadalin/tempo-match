// Spotify's iFrame API script runs eval(), which the page's CSP forbids, so this speaks the embed's postMessage protocol directly.
const SPOTIFY_EMBED_ORIGIN = 'https://open.spotify.com';
const EMBED_READY_TIMEOUT_MS = 10000;
const EMBED_PLAY_TIMEOUT_MS = 5000;
// The embed reports progress about once a second, so a track that plays out reaches its end from within this distance.
const FINAL_STEP_MAX_MS = 2500;

/**
 * Watches one Spotify embed iframe. Calls on.ended once when its track plays out (not on a pause or a seek to the end),
 * on.blocked when play() starts no playback, and on.unavailable once when the embed stops speaking the expected protocol.
 */
function watchSpotifyEmbed(iframe, on) {
  let ready = false;
  let wantsPlay = false;
  let previous = null;
  let readyTimer;
  let playTimer;

  const send = (command) => {
    iframe.contentWindow?.postMessage({ command }, SPOTIFY_EMBED_ORIGIN);
  };

  const stop = () => {
    window.removeEventListener('message', receive);
    clearTimeout(readyTimer);
    clearTimeout(playTimer);
  };

  const fail = () => {
    stop();
    on.unavailable();
  };

  const startPlay = () => {
    send('play');
    playTimer = setTimeout(on.blocked, EMBED_PLAY_TIMEOUT_MS);
  };

  const onReady = () => {
    ready = true;
    clearTimeout(readyTimer);
    send('load_complete_ack');
    if (wantsPlay) {
      startPlay();
    }
  };

  const onPlayback = (state) => {
    if (!state.isPaused) {
      clearTimeout(playTimer);
    }
    if (playedOut(previous, state)) {
      on.ended();
    }
    previous = state;
  };

  function receive(event) {
    if (event.origin !== SPOTIFY_EMBED_ORIGIN || event.source !== iframe.contentWindow) {
      return;
    }

    const message = event.data;
    if (message?.type === 'ready') {
      onReady();
      return;
    }
    if (message?.type !== 'playback_update') {
      return;
    }
    if (!playbackState(message.payload)) {
      fail();
      return;
    }
    onPlayback(message.payload);
  }

  window.addEventListener('message', receive);
  iframe.addEventListener('load', () => {
    if (!ready) {
      readyTimer = setTimeout(fail, EMBED_READY_TIMEOUT_MS);
    }
  });

  return {
    play() {
      wantsPlay = true;
      if (ready) {
        startPlay();
      }
    },
    stop,
  };
}

function playbackState(payload) {
  return typeof payload?.isPaused === 'boolean' && Number.isFinite(payload.position) && Number.isFinite(payload.duration);
}

function playedOut(before, now) {
  if (before === null || now.duration <= 0) {
    return false;
  }
  return now.position >= now.duration && before.position < now.duration && now.duration - before.position <= FINAL_STEP_MAX_MS;
}
