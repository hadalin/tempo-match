# tempo-match

[![Tests](https://github.com/hadalin/tempo-match/actions/workflows/test.yml/badge.svg)](https://github.com/hadalin/tempo-match/actions/workflows/test.yml)

Pick a BPM, get a song at that tempo with a Spotify link. Live at <https://tempo-match.hadalin.me>.
The autoplay button next to Find a song cycles off, autoplay, and autoplay random. After you start the first song,
autoplay plays another song at the same tempo when it ends; autoplay random picks a song at another tempo instead
and sets the BPM to it.

Spotify no longer serves tempo data to new apps, so tempo comes from
[GetSongBPM](https://getsongbpm.com/api) and [Deezer](https://developers.deezer.com/api).

## Why

Practicing to a metronome is fine, but it can also be boring. Pick a tempo, find a song at exactly that speed, and practice to real music instead of clicks. You might discover something new along the way.

## How it works

```
visitor -> Cloudflare -> matcher (public, :3000)            collector (private, :3001)
                           | reads, read-only                 | writes; the only upstream caller
                           v                                  v
                      catalog.db (one SQLite file on the songs volume)
                                                              ^
                    GetSongBPM, Deezer, Spotify, ReccoBeats --+  one call at a time per service
```

- **matcher** answers every request from `catalog.db`: no API keys, no upstream calls, so a traffic spike
  costs no Spotify quota. An empty tempo answers "try again in a minute".
- **collector** crawls GetSongBPM (weekly) and Deezer (every 14 days) for songs by BPM, looks each one up on
  Spotify, and checks its tempo with [ReccoBeats](https://reccobeats.com). Spotify gets one call per 3 s and at
  most 5,000 a UTC day; bans from HTTP 429 are stored in the file and honoured across restarts.
- **catalog** is the library both share: schema, transitions and queries.

Only Spotify track ids that Spotify marks playable in `SPOTIFY_MARKET` (default `US`) are stored, for 180 days at
most, and looked up again a week before. Visitors from every country get those picks. The page replaces a song whose
embed never loads and reports it; when visitors from 3 networks in the market report one within a day, the
collector looks it up again.

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

The matcher answers 503 until the collector has created `catalog.db`, and each tempo once its first song is in.

To try the rate-limit countdown locally, allow 3 requests per 20 seconds,
then tap Find a song 4 times: `SIMULATE_RATE_LIMIT=3/20 npm start`.

## Test

```sh
npm test
npm run typecheck
```

## Self-hosting

`compose.yaml` runs both services from one image and publishes only the matcher, on `127.0.0.1:8095` for a
reverse proxy or tunnel on the same host; keep it there, since the matcher trusts Cloudflare's `CF-IPCountry` and
`CF-Connecting-IP` headers. Set the variables above as Portainer stack environment variables (Git repository
stack, compose path `compose.yaml`), or in a `.env` next to `compose.yaml` and run:

```sh
docker compose up -d --build
```

`catalog.db` lives in the `songs` volume at `/data/catalog.db`; a lost volume is rebuilt by the collector from
scratch. The admin command reads and changes it without calling any service:

```sh
docker compose exec collector node packages/collector/src/admin.ts status
docker compose exec collector node packages/collector/src/admin.ts hold spotify --reason "why"
docker compose exec collector node packages/collector/src/admin.ts unblock spotify
docker compose exec collector node packages/collector/src/admin.ts clear-ban spotify --reason "why"
```

A 401 or 403, or Spotify results without `is_playable`, hold that service until `unblock`. A Cloudflare rate limit of
30 requests per 10 seconds per IP on `/api/song` protects the origin; no request reaches an upstream service.

## License

[MIT](LICENSE)
