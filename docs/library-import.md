# Importing a large PDF library

Built for a 1 690-file classical guitar collection (one folder, one download manifest,
~246 MB) that had to become a searchable library. Nothing here is specific to that pack:
any folder of PDFs works, and a folder that ships a download manifest works better.

## Sources of truth, in order

| # | Source | Why it is used | Coverage in the first pack |
|---|---|---|---|
| 1 | **Download manifest** (`links.tsv`, `video_title` column) | Carries the site's own title and credit: `TAB/Sheet: Oblivion (Arranged by Roland Dyens) by Astor Piazzolla [PDF + Guitar Pro + MIDI]` | 1690 / 1690 files |
| 2 | **The page itself** (`pdftotext`) | Settles questions the manifest cannot: which of two contradictory rows a reused file actually holds | 1688 / 1690 had a text layer |
| 3 | **File name** (`composer-piece.pdf`) | Only source when there is no manifest, and the composer fallback when the manifest forgot the credit | always available |

`backend/naming.ts` holds the parsers; `extra/preview-manifest.ts` prints what an import
*would* create before anything is written.

## The pipeline

```
pack folder ──▶ preview-manifest (report, writes nothing)
           └──▶ import-manifest
                    ├─ join manifest rows to files by local_filename
                    ├─ pdftotext: page text + page count (and scan detection)
                    ├─ resolve contradictory rows by scoring each candidate title
                    │   against the words printed on the page
                    ├─ parse title / composer / arranger
                    ├─ merge composer spellings (COMPOSER_ALIASES)
                    ├─ createTab() — the app's own write path, so an imported tab is
                    │   indistinguishable from an uploaded one
                    └─ indexTabText() — the page text goes into FTS5 for content search
```

Metadata written per tab: `title`, `artist` (the composer), `arranger`, `collection`,
`tags` (`source:<pack>`, qualifier tags, `arranger:<name>`, `scan`), `sourceTitle` (the raw
manifest title, kept so a bad parse can be corrected without the pack), `pageCount`,
`hasText`.

## Decisions worth knowing

- **The composer is `artist`.** In a classical library the composer is what you group and
  search by; the arranger is a tag (`arranger:David Russell`) rather than a second name
  field, because one piece has one composer and many arrangements.
- **Composer aliases are merged** so a library is not split across spellings:
  `J.S Bach` / `Bach` / `Johann Sebastian Bach` are one entry. The alias table only holds
  names seen in real data — guessing new ones is how you invent a composer.
- **A file name may only supply a composer that the library already uses elsewhere.**
  `ojos-negros.pdf` is a Russian folksong; without this rule the slug would have invented a
  composer called "Ojos".
- **Anonymous material is named `Traditional`**, not left blank and not guessed at.
- **The page beats the manifest** when rows contradict each other. A reused file name
  (`paganini-son30.pdf` held both "Sonata 30" and "Sonata No.3") is resolved by reading the
  text on page 1 — "Sonata No. 30 in A".
- **Scans are tagged, not OCR'd on import.** In the first pack 2 of 1690 files had no text
  layer. They are tagged `scan` and findable with `?hasText=0`, so OCR stays a deliberate
  choice (it is 10–30 s per page) instead of a 1 690-file surprise.

## Duplicates

Three different things, deliberately not conflated:

1. **Byte-identical** — sha256, recorded in `data/import-manifest.json`; a re-run skips them
   and reports `duplicates`. The first pack had none.
2. **Same piece, different file** — grouped by normalised `title + composer`
   (`workKey()`): `debussy-clair-de-lune.pdf` + `clair-de-lune-claude-debussy.pdf`.
3. **Siblings inside one suite** — turning up as groups because a library numbers movements
   (`Goldberg Variations` Aria/Var 1/Var 2, `Opus 41`). These are not duplicates; they belong
   together as a bundle. Distinguishing (2) from (3) is why the grouping is reported for
   review rather than auto-merged.

## Searching the result

`GET /api/tabs` accepts:

| Parameter | Matches |
|---|---|
| `q` | title, composer, collection, tags |
| `text` | the text **inside** the files (FTS5, prefix-matched, user operators quoted) |
| `collection` | one collection, case-insensitive |
| `tag` | one tag, e.g. `arranger:David Russell` or `scan` |
| `hasText` | `1` = searchable files, `0` = the scans |
| `sort` | `created`, `title`, `artist`, `collection`, `access` |

`GET /api/collections` and `GET /api/tags` return the values present with counts, for the
sidebar filters.

If the SQLite build has no FTS5, `tabs_text` still holds the page text and `text` search
falls back to `LIKE` — slower, same results.

## Operating it

```bash
# report only (safe, writes nothing)
docker compose exec tabs deno task preview-manifest --dir /import/classclef --collection classclef

# import
docker compose exec tabs deno task import-manifest --dir /import/classclef --collection classclef
# re-running is safe: byte-identical files are skipped via data/import-manifest.json
# a per-run summary (conflicts, scans, no-composer, failures) lands in data/import-report.json

# what is inside the files
docker compose exec tabs deno task probe-pdf-text --dir /import/classclef
```

Time for the first pack: ~1 690 files with `pdftotext` on each, a few minutes; the re-run
that finds every file already imported is much faster because it hashes and skips.
