# Scaling to a large library (thousands of tabs)

Why this exists: the library is a directory scan. `getAllTabs()` (`backend/tab.ts`) reads
the tab directory, parses every `config.json` and sorts the result in memory on **every**
`GET /api/tabs` — and that endpoint is what the home page, the dashboard and search all
call. Nothing is indexed, nothing is paginated, `q=` filtering happens in the browser over
the full list.

With thousands of PDFs that is both a latency problem (N file reads + JSON parses per
request) and a payload problem (the whole library on every page load).

## Measure before changing anything

The dev image carries a synthetic generator, so the numbers are reproducible rather than
anecdotal:

```bash
docker compose -f compose.dev.yaml exec -T tabs-dev deno task generate-tabs --count 2000 --pdf
# then, with a logged-in cookie:
curl -s -b cookies.txt -o /dev/null -w '%{time_total}s %{size_download} bytes\n' \
  http://127.0.0.1:47778/api/tabs
```

Do it in batches (250 at a time) and record `time_total` and `size_download` at each step:
a payload that does not grow with the batch count means the request is not returning the
library at all (check the body, not just the timing).

Baseline, dev instance, synthetic PDF tabs with 1-page files (this box, 2026-10-05).
Each request below is `GET /api/tabs` with a session cookie, over loopback:

| tabs | `GET /api/tabs` | payload |
|---|---|---|
| 0 | 8.5 ms | 252 B |
| 501 | 152 ms | 108.8 KB |
| 1001 | 421 ms | 217.5 KB |
| 1501 | 508 ms | 326.6 KB |
| 2001 | 777 ms | 435.8 KB |
| 2501 | 796 ms | 544.9 KB |
| 3001 | 874 ms | 654.1 KB |

Read it as: **the cost is linear in the number of tabs and every page load pays it** — 874 ms
of server CPU and 654 KB of JSON at 3 000 tabs, on loopback, with no network in the way. The
home page calls this endpoint on mount, so a 5–10 000 PDF library means multi-second loads and
megabyte payloads per visit, and the `q=` box filters that whole list in the browser. The
per-request cost is the N file reads + JSON parses in `getAllTabs()`; the payload is the same
list serialised whole.

(An earlier revision of this table showed a flat 5–12 ms and a 252 B payload at every size —
that was invalid: the dev container was running the deploy tree's code, so the generator never
ran and every request returned an empty library. The lesson is in the runbook: assert on the
response *contents*, not only the timing.)

## Result (branch `dev/tabs-index`, PR Progs4u/mytabs#1)

Same 3 001-tab library, same box, loopback, cookie-authed:

| request | before (scan) | after (index) |
|---|---|---|
| `GET /api/tabs` (a page) | 1.0–1.4 s / 654 KB | **7–20 ms / 43.8 KB** |
| `GET /api/tabs?q=metallica` | search was client-side over the whole list | 11.7 ms / 42 KB |
| `GET /api/tabs?limit=0` (whole library) | 1.0–1.4 s / 654 KB | 50 ms / 654 KB |
| first request after restart | 6.7 s (index built lazily) | 20 ms (built at boot) |

The index build itself is unchanged work (~7 s at 3 000 tabs) but it now runs at boot in
the background, and concurrent requests await the same pass instead of each scanning the
directory. Delete the `tabs_index` table and the next boot rebuilds it — verified by
dropping it and watching the boot log refill 3 001 rows with no request involved.

## Acceptance criteria for the fix

1. **Index instead of scan.** A SQLite table (id, title, artist, filename, original,
   created_at, last_access_at, public, fav, size, sha256) kept in step by every write path
   (`createTab`, `updateTab`, `updateTabFav`, `deleteTab`, `replaceTab`, the importer), with
   a backfill migration that indexes an existing `data/` directory on first boot.
2. **Paged API.** `GET /api/tabs?offset=&limit=&q=&sort=` returns
   `{ tabs, total, hasMore }`; the response for a page never depends on library size.
   Default page size stays large enough that the existing UI is unchanged.
3. **Search server-side.** `q` matches title/artist (and, later, extracted PDF text) in SQL.
4. **Measured targets** on this box, 5 000 tabs: `GET /api/tabs?limit=100` under 100 ms and
   well under 100 KB; the home page stays interactive while the full index is built.
5. **No regression** in the existing suite: `deno test --allow-all` (31 tests) plus the
   Playwright e2e specs that touch the list/search/home behaviour
   (`e2e/home.spec.ts`) still pass, and the importer + a real upload still show up in the
   list immediately after they finish.
6. **Backfill is safe to interrupt**: a killed indexing pass leaves the app usable and
   resumes on the next boot (the filesystem stays the source of truth; the table is a cache
   that can be deleted and rebuilt).
