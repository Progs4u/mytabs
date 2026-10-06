/**
 * progs4u fork: import a library that ships a download manifest.
 *
 * The file names in a downloaded pack ("bach-bwv401.pdf") say little; the manifest that came
 * with it ("TAB/Sheet: BWV 401 ... by Johann Sebastian Bach [PDF + Guitar Pro + MIDI]") says a
 * lot, and the PDF itself settles whatever the two disagree about. This importer combines all
 * three sources and writes the result through the app's own createTab(), so an imported tab is
 * indistinguishable from an uploaded one (same data/<id>/config.json, same index).
 *
 * Run it inside the app container so it uses that instance's data directory and database:
 *
 *   docker compose exec tabs deno task import-manifest --dir /import/classclef --collection classclef
 *   docker compose exec tabs deno task import-manifest --dir /import/classclef --dry-run
 *   docker compose exec tabs deno task import-manifest --dir /import/classclef --limit 20 --verbose
 *
 * Metadata precedence for every file:
 *   1. the manifest row, when the manifest has one row for the file name
 *   2. when it has several (the file was reused for two downloads), the row whose title
 *      matches the text printed inside the PDF best - the file decides, not the manifest
 *   3. with no manifest at all, the file name (see backend/naming.ts)
 * Composer spellings are merged through the alias table in backend/naming.ts, so one composer
 * is one entry. Unknown material is named "Traditional" rather than guessed at.
 */

import * as path from "@std/path";
import { canonicalComposer, isTraditionalTitle, parseManifestTitle, parseTabFilename } from "../backend/naming.ts";
import { supportedFormatList } from "../backend/common.ts";
import { indexTabText } from "../backend/tab-index.ts";
import { probePdf, scoreTitleAgainstText } from "../backend/pdf-text.ts";
import { createTab } from "../backend/tab.ts";
import { dataDir } from "../backend/util.ts";

interface Options {
    dir: string;
    manifest: string;
    collection: string;
    dryRun: boolean;
    limit: number;
    verbose: boolean;
    source: string;
}

interface ManifestRow {
    local_filename: string;
    video_title: string;
    video_id?: string;
    url?: string;
}

interface Report {
    dir: string;
    collection: string;
    startedAt: string;
    files: number;
    imported: number;
    duplicates: number;
    unsupported: number;
    failed: { file: string; error: string }[];
    conflicts: { file: string; chosen: string; rejected: string; scores: number[] }[];
    noComposer: string[];
    scans: string[];
    importedTabs: { id: string; file: string; title: string; artist: string; arranger: string; tags: string[] }[];
}

function parseArgs(args: string[]): Options {
    const options: Options = {
        dir: "",
        manifest: "links.tsv",
        collection: "",
        dryRun: false,
        limit: 0,
        verbose: false,
        source: "",
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dir") options.dir = args[++i] ?? "";
        else if (arg === "--manifest") options.manifest = args[++i] ?? "";
        else if (arg === "--collection") options.collection = args[++i] ?? "";
        else if (arg === "--source") options.source = args[++i] ?? "";
        else if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--verbose") options.verbose = true;
        else if (arg === "--limit") options.limit = parseInt(args[++i] ?? "0", 10);
    }

    if (!options.dir) {
        console.error("Usage: deno task import-manifest --dir <folder> [--manifest links.tsv] [--collection name] [--source name] [--dry-run] [--limit N] [--verbose]");
        Deno.exit(1);
    }

    return options;
}

function parseTsv(text: string): ManifestRow[] {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
        return [];
    }
    const header = lines[0].split("\t").map((cell) => cell.trim());
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
        for (const word of credit.split(/\s+/).filter((w) => w.length >= 3 && /^[A-Za-zÀ-ÿ'.-]+$/.test(w))) {
            const key = word.toLowerCase();
            if (!map.has(key) || (map.get(key) ?? "").length < credit.length) {
                map.set(key, credit);
            }
        }
    }
    return map;
}

async function* walk(dir: string): AsyncGenerator<string> {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
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

interface Manifest {
    [sha256: string]: { id: string; originalFilename: string; importedAt: string };
}

async function loadImportManifest(file: string): Promise<Manifest> {
    try {
        return JSON.parse(await Deno.readTextFile(file));
    } catch {
        return {};
    }
}

if (import.meta.main) {
    const options = parseArgs(Deno.args);
    const root = path.resolve(options.dir);
    const collection = options.collection || path.basename(root);
    const source = options.source || collection;
    const manifestPath = path.join(dataDir, "import-manifest.json");
    const importManifest = await loadImportManifest(manifestPath);

    let rows: ManifestRow[] = [];
    try {
        rows = parseTsv(await Deno.readTextFile(path.join(root, options.manifest)));
    } catch {
        console.warn(`No manifest at ${path.join(root, options.manifest)} — falling back to file names.`);
    }

    const byFilename = new Map<string, ManifestRow[]>();
    for (const row of rows) {
        const key = (row.local_filename ?? "").trim();
        if (key) {
            byFilename.set(key, [...(byFilename.get(key) ?? []), row]);
        }
    }
    const vocabulary = composerVocabulary(rows);

    const report: Report = {
        dir: root,
        collection,
        startedAt: new Date().toISOString(),
        files: 0,
        imported: 0,
        duplicates: 0,
        unsupported: 0,
        failed: [],
        conflicts: [],
        noComposer: [],
        scans: [],
        importedTabs: [],
    };

    console.log(`Importing ${root} as collection "${collection}"${options.dryRun ? " (dry run)" : ""}`);
    console.log(`Manifest: ${rows.length} row(s) over ${byFilename.size} file name(s) — data dir ${dataDir}\n`);

    const startedAt = Date.now();

    for await (const file of walk(root)) {
        const base = path.basename(file);
        const ext = path.extname(base).slice(1).toLowerCase();

        if (ext === "tsv" || ext === "csv" || ext === "json" || ext === "md") {
            continue;
        }
        if (!supportedFormatList.includes(ext)) {
            report.unsupported++;
            continue;
        }

        report.files++;

        try {
            const bytes = await Deno.readFile(file);
            const digest = await sha256(bytes);

            if (importManifest[digest]) {
                report.duplicates++;
                if (options.verbose) {
                    console.log(`  dupe    ${base} (already tab ${importManifest[digest].id})`);
                }
                continue;
            }

            const parsedName = parseTabFilename(base);
            const candidates = byFilename.get(base) ?? [];

            // Read the file once: the text is used for search, for page count, and to settle
            // contradictory manifest rows.
            const isPdf = ext === "pdf";
            const probe = isPdf ? await probePdf(file) : { text: "", pageCount: 0, hasText: false };
            if (isPdf && !probe.hasText) {
                report.scans.push(base);
            }

            let title = parsedName.title;
            let artist = parsedName.artist;
            let arranger = "";
            let sourceTitle = "";

            if (candidates.length > 0) {
                const scored = candidates.map((candidate) => ({
                    candidate,
                    score: scoreTitleAgainstText(candidate.video_title ?? "", probe.text),
                }));
                const best = scored.reduce((a, b) => (b.score > a.score ? b : a));

                if (candidates.length > 1 && scored.some((s) => s.candidate !== best.candidate && s.score > 0)) {
                    report.conflicts.push({
                        file: base,
                        chosen: best.candidate.video_title,
                        rejected: scored.filter((s) => s !== best).map((s) => s.candidate.video_title).join(" || "),
                        scores: scored.map((s) => Math.round(s.score * 100)),
                    });
                }

                const parsed = parseManifestTitle(best.candidate.video_title ?? "", base, vocabulary);
                title = parsed.title;
                artist = parsed.artist;
                arranger = parsed.arranger;
                sourceTitle = parsed.sourceTitle;
            }

            const canonical = canonicalComposer(artist);
            artist = canonical !== "" ? canonical : isTraditionalTitle(title) ? "Traditional" : "";
            if (artist === "") {
                report.noComposer.push(base);
            }

            const tags = [`source:${source}`, ...parsedName.tags];
            if (arranger !== "") {
                tags.push(`arranger:${canonicalComposer(arranger)}`);
            }
            if (!probe.hasText && isPdf) {
                tags.push("scan");
            }

            if (options.dryRun) {
                console.log(
                    `  add     ${title}${artist ? " | " + artist : " | (no composer)"}${arranger ? " (arr. " + arranger + ")" : ""}  [${ext}, ${probe.pageCount}p]`,
                );
            } else {
                const id = await createTab(bytes, ext, title, artist, base, {
                    collection,
                    tags,
                    arranger,
                    source,
                });
                if (isPdf) {
                    indexTabText(id, probe.text);
                    if (probe.pageCount > 0) {
                        const { db } = await import("../backend/db.ts");
                        db.prepare("UPDATE tabs_index SET pageCount = ? WHERE id = ?").run(probe.pageCount, id);
                    }
                }
                importManifest[digest] = { id, originalFilename: base, importedAt: new Date().toISOString() };

                report.importedTabs.push({ id, file: base, title, artist, arranger, tags });
                if (options.verbose) {
                    console.log(`  ok      #${id} ${title}${artist ? " | " + artist : ""}`);
                }
            }

            report.imported++;

            if (options.limit > 0 && report.imported >= options.limit) {
                console.log(`Reached --limit ${options.limit}, stopping.`);
                break;
            }
        } catch (e) {
            report.failed.push({ file: base, error: (e as Error).message });
            console.error(`  FAILED  ${base}: ${(e as Error).message}`);
        }
    }

    if (!options.dryRun) {
        await Deno.writeTextFile(manifestPath, JSON.stringify(importManifest, null, 2));
    }

    const reportPath = path.join(dataDir, "import-report.json");
    await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2));

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log("");
    console.log("---- summary ----");
    console.log(`candidates   : ${report.files}`);
    console.log(`imported     : ${report.imported}${options.dryRun ? " (dry run, nothing written)" : ""}`);
    console.log(`duplicates   : ${report.duplicates}`);
    console.log(`unsupported  : ${report.unsupported}`);
    console.log(`failed       : ${report.failed.length}`);
    console.log(`no composer  : ${report.noComposer.length}`);
    console.log(`scans (no text layer): ${report.scans.length}`);
    console.log(`manifest rows the file overruled: ${report.conflicts.length}`);
    console.log(`took         : ${seconds}s`);
    console.log(`report       : ${reportPath}`);

    if (report.failed.length > 0) {
        console.log("\nFailures:");
        for (const failure of report.failed.slice(0, 20)) {
            console.log(`  ${failure.file}: ${failure.error}`);
        }
    }

    if (report.conflicts.length > 0) {
        console.log("\nContradictory manifest rows, resolved by the page:");
        for (const conflict of report.conflicts) {
            console.log(`  ${conflict.file}  scores ${JSON.stringify(conflict.scores)}`);
            console.log(`     chosen  : ${conflict.chosen}`);
        }
    }
}
