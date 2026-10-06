/**
 * progs4u dev tool: show what the importer would make of a folder of files, before it
 * touches the library.
 *
 *   deno task preview-names --dir /import
 *
 * Prints one line per file (what it would become), then the groups that look like the same
 * piece in different qualities and the exact duplicates. Nothing is written. Use it to agree
 * on the naming rules with a sample before importing thousands of files.
 */

import * as path from "@std/path";
import { parseTabFilename, workKey } from "../backend/naming.ts";
import { supportedFormatList } from "../backend/common.ts";

interface Entry {
    file: string;
    size: number;
    title: string;
    artist: string;
    sequence: number | null;
    tags: string[];
    collection: string;
    uncertainOrder: boolean;
    hash?: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
    for await (const entry of Deno.readDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory) {
            yield* walk(full);
        } else if (entry.isFile) {
            yield full;
        }
    }
}

async function sha256(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pad(value: string, width: number): string {
    return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

if (import.meta.main) {
    let dir = "";
    let checkHashes = true;

    for (let i = 0; i < Deno.args.length; i++) {
        if (Deno.args[i] === "--dir") {
            dir = Deno.args[++i] || "";
        } else if (Deno.args[i] === "--no-hash") {
            checkHashes = false;
        }
    }

    if (!dir) {
        console.error("usage: deno task preview-names --dir <folder> [--no-hash]");
        Deno.exit(1);
    }

    const root = path.resolve(dir);
    const entries: Entry[] = [];
    let skipped = 0;

    for await (const file of walk(root)) {
        const rel = path.relative(root, file) ?? file;
        const relDir = path.dirname(rel);
        const base = path.basename(file);
        const ext = path.extname(base).slice(1).toLowerCase();

        if (!supportedFormatList.includes(ext)) {
            skipped++;
            continue;
        }

        const parsed = parseTabFilename(base, relDir === "." ? "" : relDir);
        const stat = await Deno.stat(file);
        const entry: Entry = { file: rel, size: stat.size, ...parsed, hash: undefined };

        if (checkHashes) {
            entry.hash = (await sha256(await Deno.readFile(file))).slice(0, 12);
        }

        entries.push(entry);
    }

    entries.sort((a, b) => (a.collection || "").localeCompare(b.collection || "") || (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.file.localeCompare(b.file));

    console.log(`\n${entries.length} file(s) under ${root} (${skipped} not a supported format)\n`);
    console.log(`${pad("would become (title | artist)", 58)} ${pad("seq", 5)} ${pad("collection", 14)} tags`);
    console.log("-".repeat(120));

    for (const e of entries) {
        const label = `${e.title}${e.artist ? " | " + e.artist : " | (no artist)"}`;
        const flags = [e.tags.join(","), e.uncertainOrder ? "ORDER?" : ""].filter(Boolean).join(" ");
        console.log(`${pad(label, 58)} ${pad(e.sequence === null ? "-" : String(e.sequence), 5)} ${pad(e.collection || "-", 14)} ${flags}`);
    }

    // same piece, different files
    const groups = new Map<string, Entry[]>();
    for (const e of entries) {
        const key = workKey(e);
        if (!key.endsWith("|")) {
            groups.set(key, [...(groups.get(key) ?? []), e]);
        }
    }

    const sameWork = [...groups.entries()].filter(([, list]) => list.length > 1);
    console.log(`\n=== likely the same piece in more than one file (${sameWork.length} group(s)) ===`);
    for (const [key, list] of sameWork) {
        console.log(`  ${key}`);
        for (const e of list) {
            console.log(`     ${pad(e.file, 60)} ${e.tags.join(",")}`);
        }
    }

    if (checkHashes) {
        const byHash = new Map<string, Entry[]>();
        for (const e of entries) {
            byHash.set(e.hash!, [...(byHash.get(e.hash!) ?? []), e]);
        }
        const exact = [...byHash.values()].filter((list) => list.length > 1);
        console.log(`\n=== byte-identical duplicates (${exact.length} group(s)) ===`);
        for (const list of exact) {
            console.log(`  hash ${list[0].hash}:`);
            for (const e of list) {
                console.log(`     ${e.file}`);
            }
        }
    }

    const collections = new Map<string, number>();
    for (const e of entries) {
        collections.set(e.collection || "(none)", (collections.get(e.collection || "(none)") ?? 0) + 1);
    }
    console.log("\n=== collections this import would create ===");
    for (const [name, count] of [...collections.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${pad(name, 24)} ${count} file(s)`);
    }

    const tagCounts = new Map<string, number>();
    for (const e of entries) {
        for (const tag of e.tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
    }
    console.log("\n=== tags ===");
    for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${pad(tag, 24)} ${count}`);
    }

    console.log("");
}
