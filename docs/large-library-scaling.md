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

Baseline, dev instance, synthetic PDF tabs (this box, 2026-10-05):

| tabs | `GET /api/tabs` | payload |
|---|---|---|
| 0 | 12 ms | 252 B |
| 250 | 7 ms | 252 B |
| 500 | 8 ms | 252 B |
| 750 | 7 ms | 252 B |
| 1000 | 7 ms | 252 B |
| 1250 | 8 ms | 252 B |
| 1500 | 6 ms | 252 B |
| 1750 | 5 ms | 252 B |
| 2000 | 5 ms | 252 B |

These numbers are **invalid as a baseline**: the payload never grew, i.e. the response was
an empty library, because the running dev container was built from the deploy tree (`src/`)
and therefore did not contain the generator at all — the task never ran. Re-run after the
dev image was fixed to build from `./dev` (see the Dockerfile `dev` stage) and fill the
table in with real values before treating any of it as evidence.

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
