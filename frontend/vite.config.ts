import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { alphaTab } from "@coderline/alphatab-vite";
import viteCompression from "vite-plugin-compression";
import { visualizer } from "rollup-plugin-visualizer";

// @ts-ignore
import * as jsonc from "jsr:@std/jsonc";

const viteCompressionFilter = /\.(js|mjs|json|css|html|svg)$/i;

// @ts-ignore
const denoJSONC = jsonc.parse(await Deno.readTextFile("../deno.jsonc"));

// Parse deno.jsonc
const appVersion: string = denoJSONC.version;

/**
 * progs4u: pdf.js loads the 14 standard PDF fonts and CJK cmaps from separate
 * files at runtime. They are shipped next to the bundle (dist/pdfjs/...) and
 * fetched by the PDF viewer; without them, PDFs that rely on non-embedded
 * standard fonts render with a substitute font.
 */
function copyPdfJsAssets() {
    const dirs = ["standard_fonts", "cmaps"];

    return {
        name: "copy-pdfjs-assets",
        async closeBundle() {
            const { cp } = await import("node:fs/promises");

            for (const dir of dirs) {
                const from = `node_modules/pdfjs-dist/${dir}`;
                const to = `../dist/pdfjs/${dir}`;
                try {
                    await cp(from, to, { recursive: true });
                    console.log(`copied ${from} -> ${to}`);
                } catch (e) {
                    console.warn(`could not copy ${from}: ${e.message}`);
                }
            }
        },
    };
}

// https://vite.dev/config/
export default defineConfig({
    define: {
        appVersion: JSON.stringify(appVersion),
    },
    build: {
        outDir: "../dist",
        emptyOutDir: true,
    },
    plugins: [
        vue(),
        alphaTab(),
        viteCompression({
            algorithm: "gzip",
            filter: viteCompressionFilter,
        }),
        // https://github.com/denoland/deno/issues/30430
        // Deno 2.4.4 issue, temporarily disable brotli
        /* viteCompression({
            algorithm: "brotliCompress",
            filter: viteCompressionFilter,
        }),*/
        visualizer({
            filename: "../data/stats.html",
        }),
        copyPdfJsAssets(),
    ],

    server: {
        host: "0.0.0.0",
    },
});
