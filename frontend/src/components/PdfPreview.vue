<script>
/**
 * progs4u fork: the library's preview pane.
 *
 * Picking what to play means looking at the page, not opening it: a single click in the list
 * shows page 1 here (fit to the panel width, so the first systems - roughly the first 16 bars -
 * are readable at a glance), a double click opens the full viewer. Nothing is fetched until a
 * tab is selected, and switching selection tears the previous document down, so browsing a
 * 1690-file library does not pile up pdf.js documents.
 */
import { defineComponent, markRaw } from "vue";
import { baseURL } from "../app.js";
import { isPdfTab } from "../pdf.js";

import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default defineComponent({
    props: {
        tab: {
            type: Object,
            default: null,
        },
    },

    data() {
        return {
            loading: false,
            error: "",
            pageCount: 0,
            // Bumped on every selection change; a load whose token is stale discards its
            // result instead of painting over the newer selection.
            loadToken: 0,
            resizeTimer: null,
        };
    },

    computed: {
        isPdf() {
            return isPdfTab(this.tab);
        },
    },

    watch: {
        "tab.id": {
            immediate: true,
            handler() {
                this.render();
            },
        },
    },

    mounted() {
        window.addEventListener("resize", this.onResize);
    },

    beforeUnmount() {
        window.removeEventListener("resize", this.onResize);
        this.dispose();
    },

    methods: {
        isPdfTab,

        dispose() {
            try {
                this.pdf?.destroy();
            } catch {
                // a document that is already gone is not an error
            }
            this.pdf = null;
        },

        onResize() {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => this.render(), 250);
        },

        async render() {
            const token = ++this.loadToken;
            this.error = "";
            this.pageCount = 0;
            this.dispose();

            if (!this.isPdf) {
                this.loading = false;
                return;
            }

            this.loading = true;

            try {
                // markRaw: pdf.js objects use JS private fields, and Vue's reactive proxy
                // turns access to them into "Cannot read private member #x ...". Keep raw.
                const document_ = await pdfjs.getDocument({
                    url: `${baseURL}/api/tab/${this.tab.id}/file?inline=1`,
                    withCredentials: true,
                    standardFontDataUrl: `${baseURL}/pdfjs/standard_fonts/`,
                    cMapUrl: `${baseURL}/pdfjs/cmaps/`,
                    cMapPacked: true,
                }).promise;

                if (token !== this.loadToken) {
                    document_.destroy();
                    return;
                }

                this.pdf = markRaw(document_);
                this.pageCount = document_.numPages;

                const page = await document_.getPage(1);
                if (token !== this.loadToken) {
                    return;
                }

                const body = this.$refs.body;
                const width = Math.max(120, (body?.clientWidth ?? 320) - 2);

                // Fit the page width: a page that is legible at the top beats a thumbnail
                // that has to be opened to be judged.
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: width / base.width });

                const canvas = this.$refs.canvas;
                const ratio = window.devicePixelRatio || 1;
                canvas.width = Math.floor(viewport.width * ratio);
                canvas.height = Math.floor(viewport.height * ratio);
                canvas.style.width = `${Math.floor(viewport.width)}px`;
                canvas.style.height = `${Math.floor(viewport.height)}px`;

                await page.render({
                    canvasContext: canvas.getContext("2d"),
                    viewport,
                    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
                }).promise;
            } catch (e) {
                if (token !== this.loadToken) {
                    return;
                }
                this.error = e?.message ? `Could not load the preview: ${e.message}` : "Could not load the preview";
            } finally {
                if (token === this.loadToken) {
                    this.loading = false;
                }
            }
        },
    },
});
</script>

<template>
    <div class="pdf-preview">
        <div v-if="!tab" class="preview-empty">
            <font-awesome-icon icon="file-pdf" class="preview-empty-icon" />
            <div>Click a tab to preview it here</div>
            <div class="preview-hint">↓ / ↑ to walk the list · double click to open</div>
        </div>

        <template v-else>
            <div class="preview-head">
                <div class="preview-title" :title="tab.title">{{ tab.title }}</div>
                <div class="preview-sub">
                    <span v-if="tab.artist">{{ tab.artist }}</span>
                    <span v-if="tab.arranger" class="preview-arranger">arr. {{ tab.arranger }}</span>
                </div>
                <div class="preview-hint">single click previews · double click opens</div>
            </div>

            <div class="preview-body" ref="body">
                <span v-if="loading" class="preview-msg">Loading…</span>
                <span v-else-if="error" class="preview-msg error">{{ error }}</span>
                <span v-else-if="!isPdf" class="preview-msg">
                    No preview for this format — double click to open it
                </span>
                <canvas v-show="isPdf && !error" ref="canvas"></canvas>
            </div>

            <div class="preview-foot">
                <span v-if="isPdf && pageCount">page 1 of {{ pageCount }}</span>
                <span v-else-if="isPdf && !pageCount">&nbsp;</span>
                <span class="preview-foot-hint">scroll for more of the page</span>
            </div>
        </template>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/vars.scss";

.pdf-preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background-color: rgba(0, 0, 0, 0.16);
    border-radius: 25px;
    padding: 14px 16px;
}

.preview-empty {
    margin: auto;
    text-align: center;
    color: $color2-dark;

    .preview-empty-icon {
        font-size: 28px;
        opacity: 0.5;
        margin-bottom: 8px;
    }
}

.preview-head {
    flex: 0 0 auto;
    margin-bottom: 8px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    padding-bottom: 6px;

    .preview-title {
        font-weight: 600;
        font-size: 1.05rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .preview-sub {
        color: $color2-dark;
        font-size: 0.9rem;

        .preview-arranger {
            font-style: italic;
            margin-left: 8px;
            opacity: 0.85;
        }
    }

    .preview-hint {
        font-size: 0.72rem;
        opacity: 0.55;
    }
}

.preview-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    text-align: center;

    // A page is rendered at its natural height and simply cut off here: what matters at a
    // glance is the top of the page, and the rest is one scroll away.
    canvas {
        display: block;
        margin: 0 auto;
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
        background-color: #fff;
    }

    .preview-msg {
        display: block;
        color: $color2-dark;
        padding-top: 20px;

        &.error {
            color: #b3261e;
        }
    }
}

.preview-foot {
    flex: 0 0 auto;
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    opacity: 0.6;
    padding-top: 4px;
}
</style>
