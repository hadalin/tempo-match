# tempo-match

[![Tests](https://github.com/hadalin/tempo-match/actions/workflows/test.yml/badge.svg)](https://github.com/hadalin/tempo-match/actions/workflows/test.yml)

Pick a BPM, get a song at that tempo with a Spotify link. Live at <https://tempo-match.hadalin.me>.

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

Optional: `SPOTIFY_MARKET` (default `US`), `DATA_DIR` (directory of `catalog.db`, default the working directory),
`DEEZER_ENABLED=false`, `RECCOBEATS_ENABLED=false` (skips the tempo check), `COLLECTOR_URL` (matcher only).

```sh
npm install
npm run collect    # the collector; fills catalog.db at its own pace
npm start          # the matcher, http://localhost:3000
npm run dev        # the matcher, restarting on changes under packages/
npm run admin -- status
```

## Test

```sh
npm test
npm run typecheck
npm run bench -- 200 60 mixed   # matcher load: requests per second, seconds, mixed or lucky; no upstream calls
```

## License

[MIT](LICENSE)
