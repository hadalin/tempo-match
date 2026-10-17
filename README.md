# tempo-match

[![Tests](https://github.com/hadalin/tempo-match/actions/workflows/test.yml/badge.svg)](https://github.com/hadalin/tempo-match/actions/workflows/test.yml)

Pick a BPM, get a song at that tempo with a Spotify link. Live at <https://tempo-match.hadalin.me>.
The autoplay button next to Find a song cycles off, autoplay, and autoplay random. After you start the first song,
autoplay plays another song at the same tempo when it ends; autoplay random picks a random popular Spotify track
instead and sets the BPM to its tempo.

Spotify no longer serves tempo data to new apps, so tempo comes from
[GetSongBPM](https://getsongbpm.com/api) and [Deezer](https://developers.deezer.com/api).

## Why

Practicing to a metronome is fine, but it can also be boring. Pick a tempo, find a song at exactly that speed, and practice to real music instead of clicks. You might discover something new along the way.

## Run

Requires Node.js 24+. Copy `.env.example` to `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `GETSONGBPM_API_KEY` | <https://getsongbpm.com/api> (free; needs a website linking back to getsongbpm.com) |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | App at <https://developer.spotify.com/dashboard> (Web API; owner needs Premium) |

Optional: `SPOTIFY_MARKET` (default `US`), `PORT` (default `3000`), `DEEZER_ENABLED=false`,
`RECCOBEATS_ENABLED=false` (skips the [ReccoBeats](https://reccobeats.com) tempo check and turns off autoplay random).

```sh
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on changes under packages/
```

To try the rate-limit countdown locally, allow 3 requests per 20 seconds,
then tap Find a song 4 times: `SIMULATE_RATE_LIMIT=3/20 npm start`.

## Test

```sh
npm test
npm run typecheck
```

## Self-hosting

`compose.yaml` publishes the app on `127.0.0.1:8095` for a reverse proxy or tunnel on the
same host; keep it there, since the server trusts Cloudflare's `CF-IPCountry` header. Set the
variables above as Portainer stack environment variables (Git repository stack, compose path
`compose.yaml`), or in a `.env` next to `compose.yaml` and run:

```sh
docker compose up -d --build
```

## License

[MIT](LICENSE)
