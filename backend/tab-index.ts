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
 *
 * Two tables beyond the tab list:
 *  - `tabs_index` carries the library metadata the importer derives (collection, tags,
 *    arranger, source) so the list can be filtered without opening config.json.
 *  - `tabs_text` (FTS5) holds the text printed inside each PDF, so a search can find the
 *    chord on page 3 rather than only matching the file name.
 */

import { db } from "./db.ts";
import type { TabInfo } from "./zod.ts";

export interface TabQuery {
    limit?: number;
    offset?: number;
    /** Free text matched against title, artist, collection and tags. */
    q?: string;
    /**
     * Free text matched against the text printed inside the files (FTS5). Separate from `q`
     * because it is a different kind of search: `q` matches what the tab *is called*, this
     * matches what is *on the page*.
     */
    text?: string;
    /** Exact collection name (case-insensitive). */
    collection?: string;
    /** Tabs carrying this tag. */
    tag?: string;
    /** Only favorites. */
    fav?: boolean;
    /** Only tabs that have been opened at least once (lastAccessAt set). */
    opened?: boolean;
    /** 1 = only files with a searchable text layer, 0 = only files without one. */
    hasText?: 0 | 1;
    sort?: "created" | "title" | "artist" | "access" | "collection";
    order?: "asc" | "desc";
}

export interface TabQueryResult {
    tabs: TabInfo[];
    /** Total number of rows matching the filters, ignoring limit/offset. */
    total: number;
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
    collection: string;
    tags: string;
    arranger: string;
    source: string;
    hasText: number;
    pageCount: number;
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
    indexedAt TEXT NOT NULL DEFAULT '',
    collection TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    arranger TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    hasText INTEGER NOT NULL DEFAULT 0,
    pageCount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tabs_index_created ON tabs_index (createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_tabs_index_title ON tabs_index (title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tabs_index_artist ON tabs_index (artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tabs_index_access ON tabs_index (lastAccessAt DESC);
CREATE INDEX IF NOT EXISTS idx_tabs_index_fav ON tabs_index (fav);
CREATE INDEX IF NOT EXISTS idx_tabs_index_collection ON tabs_index (collection COLLATE NOCASE);
`;

/**
 * Text printed inside the files. A plain table plus an FTS5 mirror: the plain table is the
 * durable copy (an FTS5 table can be rebuilt from it at any time), the FTS5 table does the
 * searching. If FTS5 is unavailable in the SQLite build, search falls back to LIKE.
 */
const CREATE_TEXT_SQL = `
CREATE TABLE IF NOT EXISTS tabs_text (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    chars INTEGER NOT NULL DEFAULT 0,
    extractedAt TEXT NOT NULL DEFAULT ''
);
`;

const CREATE_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS tabs_text_fts USING fts5(id UNINDEXED, text);
`;

/** Columns added after the first release; existing databases get them via ALTER TABLE. */
const ADDED_COLUMNS: [string, string][] = [
    ["collection", "TEXT NOT NULL DEFAULT ''"],
    ["tags", "TEXT NOT NULL DEFAULT '[]'"],
    ["arranger", "TEXT NOT NULL DEFAULT ''"],
    ["source", "TEXT NOT NULL DEFAULT ''"],
    ["hasText", "INTEGER NOT NULL DEFAULT 0"],
    ["pageCount", "INTEGER NOT NULL DEFAULT 0"],
];

let isInitialized = false;
let ftsEnabled = true;

/**
 * Create the tables + indexes if they are missing. The flag keeps the hot path free of
 * DDL statements; pass `force` (boot, `?reindex=1`) to re-run it, which also covers the
 * case of the table having been dropped out-of-band.
 */
export function initTabIndex(force = false): void {
    if (isInitialized && !force) {
        return;
    }
    db.exec(CREATE_TABLE_SQL);
    migrateColumns();
    db.exec(CREATE_TEXT_SQL);

    try {
        db.exec(CREATE_FTS_SQL);
    } catch (e) {
        // Some SQLite builds are compiled without FTS5; search then uses LIKE.
        if (!ftsEnabled) {
            throw e;
        }
        console.warn(`FTS5 unavailable, full-text search falls back to LIKE: ${(e as Error).message}`);
        ftsEnabled = false;
    }

    isInitialized = true;
}

/** A database created before the library metadata existed needs the new columns added. */
function migrateColumns(): void {
    const existing = new Set(
        (db.prepare("PRAGMA table_info(tabs_index)").all() as unknown as { name: string }[]).map((row) => row.name),
    );
    for (const [name, definition] of ADDED_COLUMNS) {
        if (!existing.has(name)) {
            console.log(`Tab index: adding column ${name}`);
            db.exec(`ALTER TABLE tabs_index ADD COLUMN ${name} ${definition}`);
        }
    }
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

function rowToTabInfo(row: IndexRow): TabInfo {
    let tags: string[] = [];
    try {
        const parsed = JSON.parse(row.tags || "[]");
        if (Array.isArray(parsed)) {
            tags = parsed.filter((tag) => typeof tag === "string");
        }
    } catch {
        tags = [];
    }

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
        collection: row.collection ?? "",
        tags,
        arranger: row.arranger ?? "",
        source: row.source ?? "",
        pageCount: row.pageCount ?? 0,
        hasText: row.hasText === 1,
    };
}

/** Insert or update one tab. Safe to call after any write to config.json. */
export function indexTab(tab: TabInfo, size = 0): void {
    const ext = tab.filename.includes(".") ? tab.filename.split(".").pop()!.toLowerCase() : "";

    withSchema(() =>
        db.prepare(
            `INSERT INTO tabs_index (id, title, artist, filename, originalFilename, createdAt, lastAccessAt, public, fav, ext, size, indexedAt,
                                     collection, tags, arranger, source, hasText, pageCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            indexedAt = excluded.indexedAt,
            collection = excluded.collection,
            tags = excluded.tags,
            arranger = excluded.arranger,
            source = excluded.source,
            hasText = excluded.hasText,
            pageCount = excluded.pageCount`,
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
            tab.collection ?? "",
            JSON.stringify(tab.tags ?? []),
            tab.arranger ?? "",
            tab.source ?? "",
            tab.hasText ? 1 : 0,
            tab.pageCount ?? 0,
        )
    );
}

/**
 * Store the text extracted from a tab's file so it becomes searchable. Kept out of
 * `tabs_index` so listing the library never moves megabytes of PDF text around.
 */
export function indexTabText(id: string, text: string): void {
    const trimmed = text.slice(0, 400_000);
    withSchema(() => {
        db.prepare(
            `INSERT INTO tabs_text (id, text, chars, extractedAt) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET text = excluded.text, chars = excluded.chars, extractedAt = excluded.extractedAt`,
        ).run(id, trimmed, trimmed.length, new Date().toISOString());

        if (ftsEnabled) {
            try {
                db.prepare("DELETE FROM tabs_text_fts WHERE id = ?").run(id);
                db.prepare("INSERT INTO tabs_text_fts (id, text) VALUES (?, ?)").run(id, trimmed);
            } catch (e) {
                console.warn(`FTS index write failed for tab ${id}: ${(e as Error).message}`);
            }
        }

        db.prepare("UPDATE tabs_index SET hasText = ? WHERE id = ?").run(trimmed.trim().length > 0 ? 1 : 0, id);
    });
}

export function getTabText(id: string): string {
    const row = withSchema(() => db.prepare("SELECT text FROM tabs_text WHERE id = ?").get(id)) as { text: string } | undefined;
    return row?.text ?? "";
}

/** Cheap variant for the hot path (opening a tab): only touches the access timestamp. */
export function indexTabAccess(id: string, timestamp: string): void {
    withSchema(() => db.prepare("UPDATE tabs_index SET lastAccessAt = ? WHERE id = ?").run(timestamp, id));
}

export function unindexTab(id: string): void {
    withSchema(() => {
        db.prepare("DELETE FROM tabs_index WHERE id = ?").run(id);
        db.prepare("DELETE FROM tabs_text WHERE id = ?").run(id);
        if (ftsEnabled) {
            try {
                db.prepare("DELETE FROM tabs_text_fts WHERE id = ?").run(id);
            } catch {
                // the FTS table may predate this id; nothing to remove
            }
        }
    });
}

export function countIndexedTabs(): number {
    const row = withSchema(() => db.prepare("SELECT COUNT(*) AS count FROM tabs_index").get()) as { count: number } | undefined;
    return row?.count ?? 0;
}

export function listIndexedIds(): string[] {
    const rows = withSchema(() => db.prepare("SELECT id FROM tabs_index").all()) as unknown as { id: string }[];
    return rows.map((row) => row.id);
}

/** Distinct collections with a tab count, for the library sidebar. */
export function listCollections(): { collection: string; count: number }[] {
    const rows = withSchema(() =>
        db.prepare(
            "SELECT collection, COUNT(*) AS count FROM tabs_index GROUP BY collection COLLATE NOCASE ORDER BY collection COLLATE NOCASE",
        ).all()
    ) as unknown as { collection: string; count: number }[];
    return rows;
}

/** Distinct tags with a tab count. */
export function listTags(): { tag: string; count: number }[] {
    const rows = withSchema(() => db.prepare("SELECT tags FROM tabs_index").all()) as unknown as { tags: string }[];
    const counts = new Map<string, number>();
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.tags || "[]");
            if (Array.isArray(parsed)) {
                for (const tag of parsed) {
                    if (typeof tag === "string" && tag !== "") {
                        counts.set(tag, (counts.get(tag) ?? 0) + 1);
                    }
                }
            }
        } catch {
            // a malformed tags column must never break the list
        }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const SORT_COLUMNS: Record<string, string> = {
    created: "createdAt",
    title: "title COLLATE NOCASE",
    artist: "artist COLLATE NOCASE",
    collection: "collection COLLATE NOCASE",
    // `access` is handled separately in queryTabs(): the NULL key must NOT follow the
    // requested direction (never-opened tabs stay last either way).
    access: "lastAccessAt",
};

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

/**
 * Turn a user query into an FTS5 MATCH expression. FTS5 has its own syntax, so every token
 * is quoted and suffixed with `*` (prefix search, matching the LIKE behaviour elsewhere);
 * operators the user typed are treated as plain text rather than executed.
 */
function toFtsQuery(value: string): string {
    return value
        .split(/\s+/)
        .map((token) => token.replace(/["*():^-]/g, "").trim())
        .filter((token) => token !== "")
        .map((token) => `"${token}"*`)
        .join(" AND ");
}

/** A page of the library, newest-first by default. */
export function queryTabs(query: TabQuery = {}): TabQueryResult {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q && query.q.trim() !== "") {
        // LIKE is case-insensitive for ASCII. Tags are stored as a JSON array, so a tag
        // name matches through the same LIKE as the title does.
        const pattern = `%${escapeLike(query.q.trim())}%`;
        where.push("(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR collection LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern, pattern);
    }

    if (query.text && query.text.trim() !== "") {
        const ftsQuery = toFtsQuery(query.text);
        if (ftsEnabled && ftsQuery !== "") {
            where.push("id IN (SELECT id FROM tabs_text_fts WHERE tabs_text_fts MATCH ?)");
            params.push(ftsQuery);
        } else {
            where.push("id IN (SELECT id FROM tabs_text WHERE text LIKE ? ESCAPE '\\')");
            params.push(`%${escapeLike(query.text.trim())}%`);
        }
    }

    if (query.collection && query.collection.trim() !== "") {
        where.push("collection = ? COLLATE NOCASE");
        params.push(query.collection.trim());
    }

    if (query.tag && query.tag.trim() !== "") {
        where.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapeLike(query.tag.trim())}"%`);
    }

    if (query.hasText === 0 || query.hasText === 1) {
        where.push("hasText = ?");
        params.push(query.hasText);
    }

    if (query.fav === true) {
        where.push("fav = 1");
    }

    if (query.opened === true) {
        where.push("lastAccessAt IS NOT NULL");
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
            `SELECT id, title, artist, filename, originalFilename, createdAt, lastAccessAt, public, fav,
                    collection, tags, arranger, source, hasText, pageCount
             FROM tabs_index ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset)
    ) as unknown as IndexRow[];

    return { tabs: rows.map(rowToTabInfo), total };
}

/** Rebuild the FTS mirror from the durable text table (used after a schema change). */
export function rebuildTextIndex(): number {
    if (!ftsEnabled) {
        return 0;
    }
    const rows = withSchema(() => db.prepare("SELECT id, text FROM tabs_text").all()) as unknown as { id: string; text: string }[];
    withSchema(() => {
        db.exec("DELETE FROM tabs_text_fts");
        for (const row of rows) {
            db.prepare("INSERT INTO tabs_text_fts (id, text) VALUES (?, ?)").run(row.id, row.text);
        }
    });
    return rows.length;
}
