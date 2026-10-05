/**
 * progs4u fork: bulk importer for tab files (mostly PDF).
 *
 * Uploading thousands of PDFs one HTTP request at a time is not practical, so this
 * script writes directly into the same data directory the app uses: it creates
 * data/<id>/tab.<ext> + config.json via the app's own createTab(), exactly like an
 * upload through the web UI. Nothing else needs to be re-indexed - the tab list is
 * built by scanning the data directory.
 *
 * Run it inside the app container so it uses the same code, DB and KV store:
 *
 *   docker compose exec tabs deno task import-tabs --dir /import            # import everything
 *   docker compose exec tabs deno task import-tabs --dir /import --dry-run  # only report
 *   docker compose exec tabs deno task import-tabs --dir /import --limit 5  # first 5 files
 *
 * Suggested file naming: "Artist - Title.pdf" -> artist and title are parsed from
 * the file name, everything else keeps the file name as the title.
 */

import * as path from "@std/path";
import { parseTitleArtistFromFilename, supportedFormatList } from "../backend/common.ts";
import { createTab } from "../backend/tab.ts";
import { dataDir } from "../backend/util.ts";

interface Options {
    dir: string;
    dryRun: boolean;
    limit: number;
    quiet: boolean;
}

interface Manifest {
    [sha256: string]: {
        id: string;
        originalFilename: string;
        importedAt: string;
    };
}

function parseArgs(args: string[]): Options {
    const options: Options = {
        dir: "",
        dryRun: false,
        limit: 0,
        quiet: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dir") {
            options.dir = args[++i] || "";
        } else if (arg.startsWith("--dir=")) {
            options.dir = arg.slice("--dir=".length);
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--limit") {
            options.limit = parseInt(args[++i] || "0", 10);
        } else if (arg === "--quiet") {
            options.quiet = true;
        }
    }

    if (!options.dir) {
        console.error("Usage: deno task import-tabs --dir <folder> [--dry-run] [--limit N] [--quiet]");
        Deno.exit(1);
    }

    return options;
}

/** All files below `dir`, recursively. */
async function* walk(dir: string): AsyncGenerator<string> {
    let entries: Deno.DirEntry[];
    try {
        entries = [];
        for await (const entry of Deno.readDir(dir)) {
            entries.push(entry);
        }
    } catch (e) {
        console.error(`Cannot read ${dir}: ${(e as Error).message}`);
        return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory) {
            // Skip the app's own media folders if someone points the importer at data/.
            if (entry.name === "node_modules") {
                continue;
            }
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

async function loadManifest(manifestPath: string): Promise<Manifest> {
    try {
        return JSON.parse(await Deno.readTextFile(manifestPath));
    } catch {
        return {};
    }
}

if (import.meta.main) {
    const options = parseArgs(Deno.args);
    const manifestPath = path.join(dataDir, "import-manifest.json");
    const manifest = await loadManifest(manifestPath);

    console.log(`Importing from ${options.dir}${options.dryRun ? " (dry run)" : ""}`);
    console.log(`Data directory: ${dataDir}`);

    let found = 0;
    let imported = 0;
    let duplicates = 0;
    let unsupported = 0;
    const failures: { file: string; error: string }[] = [];
    const startedAt = Date.now();

    for await (const file of walk(options.dir)) {
        const ext = path.extname(file).slice(1).toLowerCase();

        if (!supportedFormatList.includes(ext)) {
            unsupported++;
            continue;
        }

        found++;

        try {
            const stat = await Deno.stat(file);
            const bytes = await Deno.readFile(file);
            const digest = await sha256(bytes);

            if (manifest[digest]) {
                duplicates++;
                if (!options.quiet) {
                    console.log(`  dupe   ${path.basename(file)} (already tab ${manifest[digest].id})`);
                }
                continue;
            }

            const originalFilename = path.basename(file);
            const { title, artist } = parseTitleArtistFromFilename(originalFilename);

            if (options.dryRun) {
                console.log(`  add    ${title}${artist ? " | " + artist : ""}  [${ext}, ${(stat.size / 1024).toFixed(0)} KB]`);
            } else {
                const id = await createTab(bytes, ext, title, artist, originalFilename);
                manifest[digest] = {
                    id,
                    originalFilename,
                    importedAt: new Date().toISOString(),
                };

                console.log(`  ok     #${id}  ${title}${artist ? " | " + artist : ""}`);
            }

            imported++;

            if (options.limit > 0 && imported >= options.limit) {
                console.log(`Reached --limit ${options.limit}, stopping.`);
                break;
            }
        } catch (e) {
            failures.push({ file, error: (e as Error).message });
            console.error(`  FAILED ${path.basename(file)}: ${(e as Error).message}`);
        }
    }

    if (!options.dryRun) {
        await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log("");
    console.log("---- summary ----");
    console.log(`candidates : ${found}`);
    console.log(`imported   : ${imported}${options.dryRun ? " (dry run, nothing written)" : ""}`);
    console.log(`duplicates : ${duplicates}`);
    console.log(`unsupported: ${unsupported}`);
    console.log(`failed     : ${failures.length}`);
    console.log(`took       : ${seconds}s`);

    if (failures.length > 0) {
        console.log("");
        console.log("Failures:");
        for (const failure of failures.slice(0, 50)) {
            console.log(`  ${failure.file}: ${failure.error}`);
        }
    }
}
