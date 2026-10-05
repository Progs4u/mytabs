// "deno task test" to run this test
//
// progs4u fork: the tab list is served from a SQLite index (backend/tab-index.ts) instead
// of a directory scan on every request. These tests pin the behaviour that the API and the
// home page rely on: paging without gaps or repeats, server-side search, the sort orders,
// and that the index always rebuilds from the tab directory.

import { assertEquals, assertExists } from "jsr:@std/assert@^1.0.17";
import * as fs from "@std/fs";
import * as path from "@std/path";

async function setupTest() {
    const tempDir = await Deno.makeTempDir();
    Deno.env.set("DATA_DIR", tempDir);
    Deno.env.set("MYTABS_PORT", "47779");
    return tempDir;
}

const tempDir = await setupTest();

const { createTab, deleteTab, ensureTabIndex, getTabs, getAllTabs, recordTabAccess, updateTab, updateTabFav } = await import("./tab.ts");
const { db } = await import("./db.ts");
const { countIndexedTabs, queryTabs } = await import("./tab-index.ts");
const { tabDir } = await import("./util.ts");

/** Fresh library for each test: wipe the directory and the index. */
async function resetLibrary(): Promise<void> {
    for await (const entry of Deno.readDir(tabDir)) {
        await Deno.remove(path.join(tabDir, entry.name), { recursive: true });
    }
    // Clear the rows rather than dropping the table: the point is that the index is a
    // cache, and a cleared index must be repopulated from the directory.
    try {
        db.exec("DELETE FROM tabs_index");
    } catch {
        // table not created yet on the very first reset
    }
}

async function seed(): Promise<Record<string, string>> {
    await resetLibrary();

    const ids: Record<string, string> = {};
    ids.bach = await createTab(new Uint8Array([1, 2, 3]), "pdf", "Bach Style Voicings", "J.S. Bach", "Bach - Style Voicings.pdf");
    ids.metallica = await createTab(new Uint8Array([4, 5, 6]), "gp", "Nothing Else Matters", "Metallica", "Metallica - Nothing Else Matters.gp");
    ids.acdc = await createTab(new Uint8Array([7, 8, 9]), "gp", "Back in Black", "AC/DC", "ACDC - Back in Black.gp");
    ids.pink = await createTab(new Uint8Array([10, 11, 12]), "pdf", "Wish You Were Here", "Pink Floyd", "Pink Floyd - Wish You Were Here.pdf");
    ids.queen = await createTab(new Uint8Array([13, 14, 15]), "musicxml", "Bohemian Rhapsody", "Queen", "Queen - Bohemian Rhapsody.musicxml");

    return ids;
}

Deno.test("index - createTab adds the tab to the index immediately", async () => {
    const ids = await seed();

    assertEquals(countIndexedTabs(), 5);

    const result = await getTabs({});
    assertEquals(result.total, 5);
    assertEquals(result.tabs.length, 5);
    assertEquals(result.tabs.map((tab) => tab.title).includes("Bach Style Voicings"), true);
    assertEquals(ids.bach.length > 0, true);
});

Deno.test("index - paging covers every tab exactly once", async () => {
    await seed();

    const first = await getTabs({ limit: 2, offset: 0, sort: "created", order: "desc" });
    const second = await getTabs({ limit: 2, offset: 2, sort: "created", order: "desc" });
    const third = await getTabs({ limit: 2, offset: 4, sort: "created", order: "desc" });

    assertEquals(first.total, 5);
    assertEquals(second.total, 5);
    assertEquals([first.tabs.length, second.tabs.length, third.tabs.length], [2, 2, 1]);

    const seen = [...first.tabs, ...second.tabs, ...third.tabs].map((tab) => tab.id);
    assertEquals(new Set(seen).size, 5);
});

Deno.test("index - limit 0 returns everything", async () => {
    await seed();
    const result = await getTabs({ limit: 0 });
    assertEquals(result.tabs.length, 5);
});

Deno.test("index - search matches title and artist, case-insensitively", async () => {
    await seed();

    const byTitle = await getTabs({ q: "voicings" });
    assertEquals(byTitle.total, 1);
    assertEquals(byTitle.tabs[0].title, "Bach Style Voicings");

    const byArtist = await getTabs({ q: "metallica" });
    assertEquals(byArtist.total, 1);
    assertEquals(byArtist.tabs[0].artist, "Metallica");

    const bySubstring = await getTabs({ q: "here" });
    assertEquals(bySubstring.total, 1); // "Wish You Were Here"
    assertEquals((await getTabs({ q: "WERE" })).total, 1); // case-insensitive

    const none = await getTabs({ q: "zzz" });
    assertEquals(none.total, 0);
});

Deno.test("index - search treats % and _ as literals, not wildcards", async () => {
    await seed();

    assertEquals((await getTabs({ q: "%" })).total, 0);
    assertEquals((await getTabs({ q: "_" })).total, 0);
    // ...and a query that legitimately contains them still works
    const created = await createTab(new Uint8Array([1]), "gp", "100% Metal", "Test", "100% Metal.gp");
    assertEquals((await getTabs({ q: "100%" })).total, 1);
    assertEquals((await getTabs({ q: "100%" })).tabs[0].id, created);
});

Deno.test("index - sort orders", async () => {
    await seed();

    const byTitle = await getTabs({ sort: "title", order: "asc" });
    assertEquals(byTitle.tabs.map((tab) => tab.title), [
        "Bach Style Voicings",
        "Back in Black",
        "Bohemian Rhapsody",
        "Nothing Else Matters",
        "Wish You Were Here",
    ]);

    const byArtist = await getTabs({ sort: "artist", order: "asc" });
    assertEquals(byArtist.tabs.map((tab) => tab.artist), ["AC/DC", "J.S. Bach", "Metallica", "Pink Floyd", "Queen"]);

    const newestFirst = await getTabs({ sort: "created", order: "desc" });
    assertEquals(newestFirst.tabs[0].title, "Bohemian Rhapsody");
});

Deno.test("index - favorites filter and the recents order", async () => {
    const ids = await seed();

    const tab = (await getTabs({ q: "voicings" })).tabs[0];
    await updateTabFav(tab, { fav: true });

    const favorites = await getTabs({ fav: true });
    assertEquals(favorites.total, 1);
    assertEquals(favorites.tabs[0].id, ids.bach);

    // Opening a tab records the access time, which is what the home page sorts recents by.
    await recordTabAccess(ids.acdc, "2030-01-01T00:00:00.000Z");
    const recents = await getTabs({ sort: "access", order: "desc" });
    assertEquals(recents.tabs[0].id, ids.acdc);

    // Never-opened tabs sort after opened ones in both directions, so "oldest first"
    // still means "the ones you have actually opened, least recent first".
    const recentsAsc = await getTabs({ sort: "access", order: "asc" });
    assertEquals(recentsAsc.tabs[0].id, ids.acdc);
    assertEquals(recentsAsc.tabs[1].lastAccessAt, undefined);
});

Deno.test("index - updateTab and deleteTab keep the index in step", async () => {
    const ids = await seed();

    const tab = (await getTabs({ q: "voicings" })).tabs[0];
    await updateTab(tab, { title: "Bach Style Voicings (Bass)", artist: "J.S. Bach", public: false });

    assertEquals((await getTabs({ q: "bass" })).total, 1);
    assertEquals((await getTabs({ q: "voicings" })).total, 1);

    await deleteTab(ids.queen);
    assertEquals(countIndexedTabs(), 4);
    assertEquals((await getTabs({})).total, 4);
    assertEquals((await getTabs({ q: "bohemian" })).total, 0);
});

Deno.test("index - getAllTabs still returns the whole library, newest first", async () => {
    await seed();
    const all = await getAllTabs();
    assertEquals(all.length, 5);
    assertEquals(all[0].title, "Bohemian Rhapsody");
});

Deno.test("index - rebuilds from the tab directory (index is only a cache)", async () => {
    const ids = await seed();

    // Even a dropped table is not fatal: the next reconcile recreates and refills it.
    db.exec("DROP TABLE IF EXISTS tabs_index");
    assertEquals(countIndexedTabs(), 0);

    const rebuilt = await ensureTabIndex(true);
    assertEquals(rebuilt.total, 5);
    assertEquals((await getTabs({})).total, 5);

    // A directory that disappears out-of-band (renamed into deleted/, moved by hand) is
    // dropped on the next reconcile, and a stray directory is picked up.
    await fs.ensureDir(path.join(tabDir, "deleted"));
    await Deno.rename(path.join(tabDir, ids.acdc), path.join(tabDir, "deleted", ids.acdc + "-test"));

    await fs.ensureDir(path.join(tabDir, "9999"));
    await Deno.writeFile(path.join(tabDir, "9999", "tab.gp"), new Uint8Array([1, 2]));

    const reconciled = await ensureTabIndex(true);
    assertEquals(reconciled.total, 5);
    assertEquals(reconciled.removed, 1);
    assertEquals(reconciled.indexed, 1);
    assertEquals((await getTabs({ q: "black" })).total, 0);
});

Deno.test("index - queryTabs is usable directly (no directory scan)", async () => {
    await seed();
    await ensureTabIndex();

    const result = queryTabs({ limit: 1, sort: "title", order: "asc" });
    assertEquals(result.total, 5);
    assertEquals(result.tabs.length, 1);
    assertEquals(result.tabs[0].title, "Bach Style Voicings");
});
