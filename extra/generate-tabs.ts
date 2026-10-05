/**
 * progs4u dev tool: fill a data directory with synthetic tabs to measure how the app
 * behaves with a large library (thousands of entries).
 *
 *   deno task generate-tabs --count 2000 [--pdf] [--prefix "Bench"]
 *
 * It goes through the app's own createTab(), so the result is indistinguishable from
 * files added through the UI or the bulk importer. Only ever run this against a scratch
 * data dir (the dev instance) - the ids it allocates are real.
 */

import { createTab } from "../backend/tab.ts";

const artists = [
    "Bach", "Metallica", "AC/DC", "Pink Floyd", "Django Reinhardt", "Radiohead",
    "Led Zeppelin", "Nirvana", "Queen", "Bob Dylan", "Miles Davis", "Tool",
];
const titles = [
    "Style Voicings", "Back in Black", "Wish You Were Here", "Nothing Else Matters",
    "Air on the G String", "Allegro", "Fugue in C", "Chromatic Fantasy", "Prelude",
    "Master of Puppets", "Paranoid Android", "Black Dog", "Come as You Are",
];
const kinds = ["Chords", "Tab", "Solo", "Rhythm", "Fingerstyle", "Arrangement"];

const MINIMAL_PDF = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

function parseArgs(args: string[]) {
    const options = { count: 100, pdf: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--count") {
            options.count = parseInt(args[++i] || "100", 10);
        } else if (args[i] === "--pdf") {
            options.pdf = true;
        }
    }
    return options;
}

if (import.meta.main) {
    const options = parseArgs(Deno.args);
    const started = Date.now();

    console.log(`generating ${options.count} tabs${options.pdf ? " (as PDF)" : " (as gp)"}...`);

    for (let i = 0; i < options.count; i++) {
        const artist = artists[i % artists.length];
        const title = `${titles[i % titles.length]} ${kinds[(i * 7) % kinds.length]}`;
        const bytes = options.pdf ? MINIMAL_PDF : new Uint8Array([0x50, 0x4b, 0x03, 0x04, i % 256]);
        await createTab(bytes, options.pdf ? "pdf" : "gp", `${title} #${i}`, artist, `${artist} - ${title}.${options.pdf ? "pdf" : "gp"}`);

        if ((i + 1) % 250 === 0) {
            console.log(`  ${i + 1}/${options.count}`);
        }
    }

    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
