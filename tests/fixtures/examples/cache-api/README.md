# Cache API

A caching proxy in front of a slow origin. `GET` and `HEAD` requests are served
from the Cache API when possible, and every response says `HIT`, `MISS`, or
`BYPASS` in `cf-cache-status`.

## What it shows

| Feature | Cache API |
|---|---|
| The default cache | `caches.default` |
| A separate named cache | `caches.open("thumbnails")` |
| Store a response | `put(request.url, response.clone())` |
| Serve a stored response | `match(request)` sets `cf-cache-status: HIT` |
| `HEAD` reuses the `GET` entry | `match(request, { ignoreMethod: true })` |
| `If-None-Match` (304) | `match(request)` with the client's headers |
| `Range` (206) and an unsatisfiable range (416) | `match(request)` with the client's headers |
| Expiry | `Cache-Control: max-age=1` goes stale after one second |
| Responses that are never stored | `Cache-Control: no-store` and `private` |
| Purge one entry | `delete(url)` returns `true`, then `false` |
| Turn the cache off | `ORANGE_CACHE=off` |

The origin is a function in the Worker that waits 300 ms, so a `MISS` is slow
and a `HIT` is fast. Each origin path sets its own `Cache-Control`:

| Path | `Cache-Control` | Cached |
|---|---|---|
| `/articles/<id>` | `public, max-age=60` and an `ETag` | 60 s |
| `/scores/<id>` | `max-age=1` | 1 s |
| `/videos/<id>` | `public, max-age=300`, 1 KiB of bytes | 300 s |
| `/me` | `private` | Never |
| `/live` | `no-store` | Never |

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
# MISS, then HIT with the same body.
curl -i localhost:8787/articles/a
curl -i localhost:8787/articles/a
curl -I localhost:8787/articles/a                             # HEAD, HIT

# Conditional and range requests are answered from the cache.
curl -i localhost:8787/articles/a -H 'if-none-match: "<etag>"' # 304
curl -i localhost:8787/videos/v -H 'range: bytes=256-259'      # 206
curl -i localhost:8787/videos/v -H 'range: bytes=5000-'        # 416

# Never stored: every request is a MISS with a new version.
curl -i localhost:8787/me
curl -i localhost:8787/live

# Expiry: HIT, then MISS after one second.
curl -i localhost:8787/scores/s; curl -i localhost:8787/scores/s
sleep 2; curl -i localhost:8787/scores/s

# Only GET and HEAD use the cache.
curl -i -X POST localhost:8787/articles/a                     # 405, BYPASS

# A named cache is separate from caches.default.
curl -i localhost:8787/thumbs/articles/a
curl 'localhost:8787/peek?path=/thumbs/articles/a&cache=thumbnails'  # {"cached":true}
curl 'localhost:8787/peek?path=/thumbs/articles/a'                   # {"cached":false}

# Purge one entry. The second purge finds nothing.
curl -X POST localhost:8787/purge -d '{"path":"/thumbs/articles/a","cache":"thumbnails"}'  # {"deleted":true}
curl -X POST localhost:8787/purge -d '{"path":"/thumbs/articles/a","cache":"thumbnails"}'  # {"deleted":false}
curl -X POST localhost:8787/purge -d '{"path":"/articles/a"}'                              # default cache
curl -X POST localhost:8787/purge -d '{}'                                                   # 400
```

## Restarts

Entries persist across `open-orange dev` restarts.

## Turn the cache off

On a `workers.dev` subdomain the Cache API stores nothing. To get the same
behaviour locally, set `ORANGE_CACHE` in the shell before `open-orange dev`.
Orange reads it from the shell environment, not from `.dev.vars` or
`wrangler.jsonc`.

| Variable | Values | Meaning |
|---|---|---|
| `ORANGE_CACHE` | `on` (default) or `off` | With `off`, `put` stores nothing, `match` returns `undefined`, and `delete` returns `false` |

```sh
ORANGE_CACHE=off pnpm open-orange dev
curl -i localhost:8787/articles/a; curl -i localhost:8787/articles/a   # MISS, MISS
```

## Differences from Cloudflare

- A request with several ranges gets the whole body with `200`.
- `fetch()` with `cf.cacheTtl` or `cf.cacheEverything` does not use the cache,
  as in `wrangler dev`.
