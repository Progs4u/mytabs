/**
 * progs4u dev tool: read what is actually inside the PDFs.
 *
 * Two jobs, both from the same extraction:
 *  1. Census - how many files carry a text layer (so the chords inside them can be searched)
 *     and how many are images that would need OCR.
 *  2. Disagreement - for files whose manifest rows contradict each other, look at the page
 *     itself and score each candidate title against the text printed on it.
 *
 *   deno task probe-pdf-text --dir /import/classclef [--manifest links.tsv] [--limit 20]
 *
 * Requires poppler-utils (pdftotext) in the image.
 */

import * as path from "@std/path";
import { supportedFormatList } from "../backend/common.ts";

interface ManifestRow {
    local_filename: string;
    video_title: string;
}

interface ProbeResult {
    file: string;
    textLength: number;
    firstLine: string;
    /** Words found on the page, for scoring candidate titles. */
    words: Set<string>;
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

async function walk(dir: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory) {
            files.push(...await walk(full));
        } else if (entry.isFile && supportedFormatList.includes(path.extname(entry.name).slice(1).toLowerCase())) {
            files.push(full);
        }
    }
    return files;
}

/** pdftotext the first pages of a PDF; returns "" when there is no text layer. */
export async function extractPdfText(file: string, pages = 2): Promise<string> {
    const command = new Deno.Command("pdftotext", {
        args: ["-f", "1", "-l", String(pages), "-layout", file, "-"],
        stdout: "piped",
        stderr: "null",
    });
    const { stdout } = await command.output();
    return new TextDecoder().decode(stdout);
}

function words(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9 ]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3),
    );
}

/** How well a candidate title matches the text printed on the page (0..1). */
function scoreTitle(candidate: string, pageWords: Set<string>): number {
    const tokens = candidate
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !["the", "and", "for", "with"].includes(w));
    if (tokens.length === 0) {
        return 0;
    }
    return tokens.filter((token) => pageWords.has(token)).length / tokens.length;
}

if (import.meta.main) {
    let dir = "";
    let manifestName = "links.tsv";
    let limit = 20;
    let censusOnly = false;

    for (let i = 0; i < Deno.args.length; i++) {
        const arg = Deno.args[i];
        if (arg === "--dir") dir = Deno.args[++i] ?? "";
        else if (arg === "--manifest") manifestName = Deno.args[++i] ?? "";
        else if (arg === "--limit") limit = parseInt(Deno.args[++i] ?? "20", 10);
        else if (arg === "--census-only") censusOnly = true;
    }

    if (!dir) {
        console.error("usage: probe-pdf-text --dir <folder> [--manifest links.tsv] [--limit N] [--census-only]");
        Deno.exit(1);
    }

    const root = path.resolve(dir);
    let rows: ManifestRow[] = [];
    try {
        rows = parseTsv(await Deno.readTextFile(path.join(root, manifestName)));
    } catch {
        // census still works without a manifest
    }
    const byFilename = new Map<string, ManifestRow[]>();
    for (const row of rows) {
        byFilename.set(row.local_filename.trim(), [...(byFilename.get(row.local_filename.trim()) ?? []), row]);
    }

    const files = await walk(root);
    console.log(`probing ${files.length} file(s) with pdftotext…`);

    const results: ProbeResult[] = [];
    const failures: string[] = [];

    for (const file of files) {
        const rel = path.relative(root, file);
        try {
            const text = await extractPdfText(file);
            const trimmed = text.trim();
            results.push({
                file: rel,
                textLength: trimmed.length,
                firstLine: trimmed.split("\n").map((l) => l.trim()).filter((l) => l !== "")[0] ?? "",
                words: words(trimmed),
            });
        } catch (error) {
            failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const withText = results.filter((r) => r.textLength >= 40);
    const withoutText = results.filter((r) => r.textLength < 40);
    const totalMb = 0; // reported by the shell instead

    console.log(`\n=== text layer census (${results.length} file(s)) ===`);
    console.log(`  searchable, text layer present : ${withText.length}  (${(withText.length / results.length * 100).toFixed(1)}%)`);
    console.log(`  no text layer (image only)     : ${withoutText.length}  (${(withoutText.length / results.length * 100).toFixed(1)}%)`);
    if (failures.length > 0) {
        console.log(`  pdftotext failed               : ${failures.length}`);
        for (const failure of failures.slice(0, 5)) {
            console.log(`     ${failure}`);
        }
    }
    console.log(`  ${totalMb}`);

    console.log(`\n=== first line printed on the page (${Math.min(limit, withText.length)} shown) ===`);
    for (const r of withText.slice(0, limit)) {
        console.log(`  ${r.file.padEnd(52)} ${JSON.stringify(r.firstLine.slice(0, 70))}`);
    }

    if (withoutText.length > 0) {
        console.log(`\n=== no text layer - would need OCR (${withoutText.length}) ===`);
        for (const r of withoutText.slice(0, limit)) {
            console.log(`  ${r.file.padEnd(52)} ${r.textLength} char(s)`);
        }
    }

    if (!censusOnly) {
        const disagreements = [...byFilename.entries()].filter(([, list]) => list.length > 1);
        console.log(`\n=== files whose manifest rows contradict each other (${disagreements.length}) ===`);
        for (const [filename, candidates] of disagreements) {
            const probe = results.find((r) => path.basename(r.file) === filename);
            if (!probe) {
                console.log(`  ${filename}: no probe (not a supported file?)`);
                continue;
            }
            console.log(`  ${filename}   page says: ${JSON.stringify(probe.firstLine.slice(0, 60))}  (${probe.textLength} chars)`);
            for (const candidate of candidates) {
                const score = scoreTitle(candidate.video_title, probe.words);
                const mark = score >= 0.6 ? "  <== page agrees" : "";
                console.log(`      ${(score * 100).toFixed(0).padStart(3)}%  ${candidate.video_title.slice(0, 80)}${mark}`);
            }
        }
    }
    console.log("");
}
