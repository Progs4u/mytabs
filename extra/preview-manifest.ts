/**
 * progs4u dev tool: dry-run a manifest-backed import and report exactly what would be
 * created. Reads a download manifest (classclef's links.tsv and similar exports: one row per
 * downloaded file with the real title) and never writes to the library.
 *
 *   deno task preview-manifest --dir /import/classclef --manifest links.tsv \
 *                              --collection classclef [--limit 40] [--no-hash]
 *
 * The manifest title is the primary metadata source; file names are the fallback. Composer
 * names are only taken from a file name when that name appears elsewhere in the manifest as a
 * real credit, so a slug like "ojos-negros" cannot invent a composer called "Ojos".
 */

import * as path from "@std/path";
import { canonicalComposer, isTraditionalTitle, parseManifestTitle, parseTabFilename, workKey } from "../backend/naming.ts";
import { supportedFormatList } from "../backend/common.ts";

interface ManifestRow {
    local_filename: string;
    video_title: string;
    video_id?: string;
    url?: string;
    source?: string;
	[key: string]: string | undefined;
}

interface Entry {
    file: string;
    size: number;
    title: string;
    artist: string;
    arranger: string;
    tags: string[];
    collection: string;
    sourceTitle: string;
    artistSource: "credit" | "possessive" | "filename" | "alias" | "traditional" | "none";
    ambiguousRows: number;
    hash: string;
}

function parseTsv(text: string): ManifestRow[] {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
        return [];
    }
    const header = lines[0].split("\t").map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const cells = line.split("\t");
        const row: Record<string, string> = {};
        header.forEach((key, index) => row[key] = cells[index] ?? "");
        return row as unknown as ManifestRow;
    });
}

/** Surnames seen in real credits, mapped to the fullest name the manifest uses for them. */
function composerVocabulary(rows: ManifestRow[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of rows) {
        const parts = (row.video_title ?? "").split(/\s+by\s+/i);
        if (parts.length < 2) {
            continue;
        }
        const credit = parts[parts.length - 1].replace(/\[[^\]]*\]|\|[^|]*$/g, "").trim();
        const words = credit.split(/\s+/).filter((w) => w.length >= 3 && /^[A-Za-zÀ-ÿ'.-]+$/.test(w));
        for (const word of words) {
            const key = word.toLowerCase();
            if (!map.has(key) || (map.get(key) ?? "").length < credit.length) {
                map.set(key, credit);
            }
        }
    }
    return map;
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

function pad(value: string, width: number): string {
    return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

if (import.meta.main) {
    let dir = "";
    let manifestName = "links.tsv";
    let collection = "";
    let limit = 40;
    let checkHashes = true;
    let showAll = false;

    for (let i = 0; i < Deno.args.length; i++) {
        const arg = Deno.args[i];
        if (arg === "--dir") dir = Deno.args[++i] ?? "";
        else if (arg === "--manifest") manifestName = Deno.args[++i] ?? "";
        else if (arg === "--collection") collection = Deno.args[++i] ?? "";
        else if (arg === "--limit") limit = parseInt(Deno.args[++i] ?? "40", 10);
        else if (arg === "--all") showAll = true;
        else if (arg === "--no-hash") checkHashes = false;
    }

    if (!dir) {
        console.error("usage: preview-manifest --dir <folder> [--manifest links.tsv] [--collection name] [--limit N] [--all] [--no-hash]");
        Deno.exit(1);
    }

    const root = path.resolve(dir);
    const manifestPath = path.join(root, manifestName);
    let rows: ManifestRow[] = [];
    try {
        rows = parseTsv(await Deno.readTextFile(manifestPath));
    } catch {
        console.error(`no manifest at ${manifestPath} — every file would fall back to name parsing`);
    }

    const byFilename = new Map<string, ManifestRow[]>();
    for (const row of rows) {
        const key = (row.local_filename ?? "").trim();
        if (key) {
            byFilename.set(key, [...(byFilename.get(key) ?? []), row]);
        }
    }
    const vocabulary = composerVocabulary(rows);
    const collectionName = collection || path.basename(root);

    const entries: Entry[] = [];
    let skipped = 0;
    const unknownInManifest: string[] = [];

    for await (const file of walk(root)) {
        const base = path.basename(file);
        const ext = path.extname(base).slice(1).toLowerCase();
        if (!supportedFormatList.includes(ext)) {
            continue;
        }
        const relDir = path.relative(root, path.dirname(file));

        // links.tsv itself and other bookkeeping files are not tabs
        if (ext === "tsv" || ext === "csv" || ext === "json") {
            skipped++;
            continue;
        }

        const candidates = byFilename.get(base) ?? [];
        const parsedName = parseTabFilename(base, relDir === "." ? "" : relDir);
        let title = parsedName.title;
        let artist = parsedName.artist;
        let arranger = "";
        let sourceTitle = "";
        let artistSource: Entry["artistSource"] = artist ? "credit" : "none";

        if (candidates.length > 0) {
            const manifest = parseManifestTitle(candidates[0].video_title ?? "", base, vocabulary);
            title = manifest.title;
            artist = manifest.artist;
            arranger = manifest.arranger;
            sourceTitle = manifest.sourceTitle;
            artistSource = manifest.artist === "" ? "none" : manifest.artistGuessed
                ? (parsedName.artist ? "filename" : "possessive")
                : "credit";
        } else {
            unknownInManifest.push(base);
        }

        // merge the spellings of one composer, and name anonymous material
        const canonical = canonicalComposer(artist);
        if (canonical !== artist && artist !== "") {
            artist = canonical;
            artistSource = "alias";
        } else if (artist === "" && isTraditionalTitle(title)) {
            artist = "Traditional";
            artistSource = "traditional";
        }

        const stat = await Deno.stat(file);
        let hash = "";
        if (checkHashes) {
            const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(file));
            hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
        }

        entries.push({
            file: path.relative(root, file),
            size: stat.size,
            title,
            artist,
            arranger,
            tags: parsedName.tags,
            collection: collectionName,
            sourceTitle,
            artistSource,
            ambiguousRows: candidates.length,
            hash,
        });
    }

    entries.sort((a, b) =>
        a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title) || a.file.localeCompare(b.file)
    );

    const shown = showAll ? entries : entries.slice(0, limit);
    console.log(`\n${entries.length} file(s) under ${root} — collection "${collectionName}"`);
    console.log(
        `manifest: ${rows.length} row(s), ${byFilename.size} distinct filename(s), ${vocabulary.size} composer name(s) in the vocabulary\n`,
    );
    console.log(`${pad("title", 46)} ${pad("composer", 26)} ${pad("arr", 18)} file`);
    console.log("-".repeat(140));
    for (const e of shown) {
        console.log(
            `${pad(e.title, 46)} ${pad(e.artist + (e.artistSource === "credit" ? "" : ` [${e.artistSource}]`), 26)} ${pad(e.arranger, 18)} ${e.file}`,
        );
    }
    if (!showAll && entries.length > shown.length) {
        console.log(`… ${entries.length - shown.length} more (--all to see every file)`);
    }

    const tally = (pick: (e: Entry) => string) => {
        const counts = new Map<string, number>();
        for (const e of entries) {
            counts.set(pick(e), (counts.get(pick(e)) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };

    console.log("\n=== where the composer came from ===");
    for (const [key, count] of tally((e) => e.artistSource)) {
        console.log(`  ${pad(key, 16)} ${count}`);
    }

    console.log("\n=== top composers ===");
    for (const [name, count] of tally((e) => e.artist || "(none)").slice(0, 15)) {
        console.log(`  ${pad(name, 30)} ${count}`);
    }

    const noComposer = entries.filter((e) => e.artist === "");
    console.log(`\n=== files with no composer (${noComposer.length}) ===`);
    for (const e of noComposer.slice(0, 25)) {
        console.log(`  ${pad(e.file, 46)} title=${JSON.stringify(e.title)}`);
    }
    if (noComposer.length > 25) {
        console.log(`  … ${noComposer.length - 25} more`);
    }

    const ambiguous = entries.filter((e) => e.ambiguousRows > 1);
    console.log(`\n=== files with more than one manifest row — pick one by hand (${ambiguous.length}) ===`);
    for (const e of ambiguous) {
        const rowsForFile = byFilename.get(path.basename(e.file)) ?? [];
        console.log(`  ${e.file}  -> used: ${JSON.stringify(e.title)}`);
        for (const row of rowsForFile) {
            console.log(`        alt row: ${(row.video_title ?? "").slice(0, 90)}`);
        }
    }

    if (unknownInManifest.length > 0) {
        console.log(`\n=== files with no manifest row — name parsing only (${unknownInManifest.length}) ===`);
        for (const file of unknownInManifest.slice(0, 20)) {
            console.log(`  ${file}`);
        }
    }

    if (checkHashes) {
        const byHash = new Map<string, Entry[]>();
        for (const e of entries) {
            byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e]);
        }
        const exact = [...byHash.values()].filter((list) => list.length > 1);
        console.log(`\n=== byte-identical duplicates (${exact.length} group(s), ${exact.reduce((n, l) => n + l.length, 0)} files) ===`);
        for (const list of exact.slice(0, 15)) {
            console.log(`  ${list[0].hash}:`);
            for (const e of list) {
                console.log(`     ${e.file}`);
            }
        }
        if (exact.length > 15) {
            console.log(`  … ${exact.length - 15} more group(s)`);
        }
    }

    const groups = new Map<string, Entry[]>();
    for (const e of entries) {
        const key = workKey({ title: e.title, artist: e.artist });
        if (key.endsWith("|") || key.startsWith("|")) {
            continue;
        }
        groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const sameWork = [...groups.entries()].filter(([, list]) => list.length > 1);
    console.log(`\n=== same piece in more than one file (${sameWork.length} group(s)) ===`);
    for (const [key, list] of sameWork.slice(0, 20)) {
        console.log(`  ${key}`);
        for (const e of list) {
            console.log(`     ${pad(e.file, 56)} ${e.tags.join(",")}`);
        }
    }
    if (sameWork.length > 20) {
        console.log(`  … ${sameWork.length - 20} more group(s)`);
    }

    const arrangers = tally((e) => e.arranger).filter(([name]) => name !== "");
    console.log(`\n=== arrangers (${arrangers.length}) ===`);
    for (const [name, count] of arrangers) {
        console.log(`  ${pad(name, 30)} ${count}`);
    }

    console.log(`\n=== size ===`);
    const totalBytes = entries.reduce((n, e) => n + e.size, 0);
    console.log(`  ${(totalBytes / 1024 / 1024).toFixed(1)} MB across ${entries.length} files`);
    if (skipped > 0) {
        console.log(`  (${skipped} non-tab file(s) ignored, e.g. the manifest itself)`);
    }
    console.log("");
}
