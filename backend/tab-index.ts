/**
 * progs4u fork: SQLite index over the tab library.
 *
 * Why: `getAllTabs()` reads and parses every `config.json` on every request, so the tab
 * list costs one file read per tab per call (874 ms and 654 KB of JSON at 3 000 tabs,
 * measured) and the home page calls it on mount. The index keeps the list data in SQLite
 * so a page of results costs a query instead of a directory crawl.
 *
 * The filesystem stays the source of truth: `config.json` is still what every write path
 * updates, the index is written alongside it, and `ensureTabIndex()` rebuilds the table
 * from disk (boot reconcile + `?reindex=1`). Deleting the table loses nothing.
 */

import { db } from "./db.ts";
import type { TabInfo } from "./zod.ts";

export interface TabQuery {
    limit?: number;
    offset?: number;
    /** Free text matched against title and artist. */
    q?: string;
    /** Only favorites. */
    fav?: boolean;
    sort?: "created" | "title" | "artist" | "access";
    order?: "asc" | "desc";
}

export interface TabQueryResult {
    tabs: TabInfo[];
    /** Total number of rows matching the filters, ignoring limit/offset. */
    total: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tabs_index (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    originalFilename TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT '',
    lastAccessAt TEXT,
    public INTEGER NOT NULL DEFAULT 0,
    fav INTEGER NOT NULL DEFAULT 0,
    ext TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    indexedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tabs_index_created ON tabs_index (createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_tabs_index_title ON tabs_index (title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tabs_index_artist ON tabs_index (artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tabs_index_access ON tabs_index (lastAccessAt DESC);
CREATE INDEX IF NOT EXISTS idx_tabs_index_fav ON tabs_index (fav);
`;

let isInitialized = false;

/**
 * Create the table + indexes if they are missing. The flag keeps the hot path free of
 * DDL statements; pass `force` (boot, `?reindex=1`) to re-run it, which also covers the
 * case of the table having been dropped out-of-band.
 */
export function initTabIndex(force = false): void {
    if (isInitialized && !force) {
        return;
    }
    db.exec(CREATE_TABLE_SQL);
    isInitialized = true;
}

/**
 * Run an index statement, recreating the schema once if the table is missing (someone
 * deleted it, or a fresh database landed next to an old process).
 */
function withSchema<T>(fn: () => T): T {
    initTabIndex();
    try {
        return fn();
    } catch (e) {
        if (String(e).includes("no such table")) {
            console.warn("Tab index table missing, recreating");
            initTabIndex(true);
            return fn();
        }
        throw e;
    }
}

interface IndexRow {
    id: string;
    title: string;
    artist: string;
    filename: string;
    originalFilename: string;
    createdAt: string;
    lastAccessAt: string | null;
    public: number;
    fav: number;
}

function rowToTabInfo(row: IndexRow): TabInfo {
    return {
        id: row.id,
        title: row.title,
        artist: row.artist,
        filename: row.filename,
        originalFilename: row.originalFilename,
        createdAt: row.createdAt,
        lastAccessAt: row.lastAccessAt ?? undefined,
        public: row.public === 1,
        fav: row.fav === 1,
    };
}

/** Insert or update one tab. Safe to call after any write to config.json. */
export function indexTab(tab: TabInfo, size = 0): void {
    const ext = tab.filename.includes(".") ? tab.filename.split(".").pop()!.toLowerCase() : "";

    withSchema(() =>
        db.prepare(
            `INSERT INTO tabs_index (id, title, artist, filename, originalFilename, createdAt, lastAccessAt, public, fav, ext, size, indexedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            filename = excluded.filename,
            originalFilename = excluded.originalFilename,
            createdAt = excluded.createdAt,
            lastAccessAt = excluded.lastAccessAt,
            public = excluded.public,
            fav = excluded.fav,
            ext = excluded.ext,
            size = excluded.size,
            indexedAt = excluded.indexedAt`,
        ).run(
            tab.id,
            tab.title,
            tab.artist,
            tab.filename,
            tab.originalFilename,
            tab.createdAt,
            tab.lastAccessAt ?? null,
            tab.public ? 1 : 0,
            tab.fav ? 1 : 0,
            ext,
            size,
            new Date().toISOString(),
        )
    );
}

/** Cheap variant for the hot path (opening a tab): only touches the access timestamp. */
export function indexTabAccess(id: string, timestamp: string): void {
    withSchema(() => db.prepare("UPDATE tabs_index SET lastAccessAt = ? WHERE id = ?").run(timestamp, id));
}

export function unindexTab(id: string): void {
    withSchema(() => db.prepare("DELETE FROM tabs_index WHERE id = ?").run(id));
}

export function countIndexedTabs(): number {
    const row = withSchema(() => db.prepare("SELECT COUNT(*) AS count FROM tabs_index").get()) as { count: number } | undefined;
    return row?.count ?? 0;
}

export function listIndexedIds(): string[] {
    const rows = withSchema(() => db.prepare("SELECT id FROM tabs_index").all()) as unknown as { id: string }[];
    return rows.map((row) => row.id);
}

const SORT_COLUMNS: Record<string, string> = {
    created: "createdAt",
    title: "title COLLATE NOCASE",
    artist: "artist COLLATE NOCASE",
    // `access` is handled separately in queryTabs(): the NULL key must NOT follow the
    // requested direction (never-opened tabs stay last either way).
    access: "lastAccessAt",
};

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

/** A page of the library, newest-first by default. */
export function queryTabs(query: TabQuery = {}): TabQueryResult {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q && query.q.trim() !== "") {
        // LIKE is case-insensitive for ASCII; PDF text search will need its own index.
        const pattern = `%${escapeLike(query.q.trim())}%`;
        where.push("(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
    }

    if (query.fav === true) {
        where.push("fav = 1");
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = withSchema(() => db.prepare(`SELECT COUNT(*) AS count FROM tabs_index ${whereSql}`).get(...params)) as { count: number } | undefined;
    const total = totalRow?.count ?? 0;

    const sortKey = query.sort && SORT_COLUMNS[query.sort] ? query.sort : "created";
    const direction = query.order === "asc" ? "ASC" : "DESC";

    // `id` is numeric, so it has to be cast: as text "9" sorts after "10" and paging over
    // rows with equal sort keys could then repeat or skip a tab.
    const tiebreaker = `CAST(id AS INTEGER) ${direction}`;

    const orderSql = sortKey === "access"
        // Never-opened tabs (NULL) sort last whichever direction was asked for, so the
        // recents list stays "most recently opened first" in both orders.
        ? `lastAccessAt IS NULL ASC, lastAccessAt ${direction}, ${tiebreaker}`
        : `${SORT_COLUMNS[sortKey]} ${direction}, ${tiebreaker}`;

    const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : -1;
    const offset = query.offset && query.offset > 0 ? Math.floor(query.offset) : 0;

    const rows = withSchema(() =>
        db.prepare(
            `SELECT id, title, artist, filename, originalFilename, createdAt, lastAccessAt, public, fav
             FROM tabs_index ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset)
    ) as unknown as IndexRow[];

    return { tabs: rows.map(rowToTabInfo), total };
}
