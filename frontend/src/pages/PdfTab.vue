<script>
import { defineComponent, markRaw } from "vue";
import { notify } from "@kyvg/vue3-notification";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { isLoggedIn } from "../auth-client.js";
import { baseURL, checkFetch, generalError, getSetting } from "../app.js";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// progs4u fork: PDF/document viewer for tabs that are not AlphaTab scores.
// The player in Tab.vue is score-only (notes, tracks, playback); a PDF has none
// of that, so this page renders pages with pdf.js and offers what a PDF-based
// tab actually needs: adjustable auto-scroll, page/spread navigation, zoom,
// night mode and a distraction-free fullscreen mode.

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const STORAGE_PREFIX = "pdfTab.";
/**
 * Bumped when the meaning of a stored field changes. State written before the default fit mode
 * became "page" recorded the old "width" default for every tab that was merely opened, and must
 * not keep overriding the new one - while a deliberate choice made after this version survives.
 */
const STATE_VERSION = 2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;

export default defineComponent({
    components: { FontAwesomeIcon },

    data() {
        return {
            tabID: -1,
            tab: {},
            isLoggedIn: false,

            ready: false,
            loadingText: "Loading PDF...",

            totalPages: 0,
            currentPage: 1,
            pageViews: [], // { num, width, height, rendered }
            canvases: {}, // page number -> HTMLCanvasElement

            scale: 1,
            // Fit page by default: a sheet of music should be visible whole when it opens, so
            // the top of the next system is not cut off before the first judgement is made.
            fitMode: "page", // width | page | custom
            mode: "scroll", // scroll (continuous) | page (one page at a time)

            autoScrolling: false,
            scrollSpeed: 60, // pixels per second
            endOfTabReached: false,

            night: false,
            fullscreen: false,
            showToolbar: true,
            viewerHeight: 0,

            pdf: null,
            io: null,
            rafID: null,
            lastTick: 0,
            saveStateTimer: null,
            resizeTimer: null,
            dpr: 1,

            keyEvents: (e) => {
                const element = e.target;
                if (element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)) {
                    return;
                }

                if (e.code === "Space") {
                    e.preventDefault();
                    this.toggleAutoScroll();
                } else if (e.code === "ArrowLeft" || e.code === "PageUp") {
                    e.preventDefault();
                    this.gotoPage(this.currentPage - 1);
                } else if (e.code === "ArrowRight" || e.code === "PageDown") {
                    e.preventDefault();
                    this.gotoPage(this.currentPage + 1);
                } else if (e.code === "ArrowDown") {
                    e.preventDefault();
                    this.scrollBy(80);
                } else if (e.code === "ArrowUp") {
                    e.preventDefault();
                    this.scrollBy(-80);
                } else if (e.code === "Home") {
                    e.preventDefault();
                    this.gotoPage(1);
                } else if (e.code === "End") {
                    e.preventDefault();
                    this.gotoPage(this.totalPages);
                } else if (e.code === "Equal" || e.code === "NumpadAdd") {
                    e.preventDefault();
                    this.zoom(this.scale * 1.15);
                } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
                    e.preventDefault();
                    this.zoom(this.scale / 1.15);
                } else if (e.code === "Digit0") {
                    e.preventDefault();
                    this.setFit("width");
                } else if (e.code === "KeyD") {
                    e.preventDefault();
                    this.toggleNight();
                } else if (e.code === "KeyF") {
                    e.preventDefault();
                    this.toggleFullscreen();
                }
            },
        };
    },

    created() {
        // pdf.js RenderTask instances must not live in reactive state (private
        // fields + Vue proxies do not mix), so they are kept on a plain map.
        this.renderTasks = new Map();
    },

    computed: {
        scroller() {
            return this.$refs.scroller;
        },
        isPublic() {
            return this.tab.public;
        },
        speedPercentLabel() {
            return `${this.scrollSpeed} px/s`;
        },
    },

    async mounted() {
        this.isLoggedIn = await isLoggedIn();
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.tabID = this.$route.params.id;

        this.restoreState();
        window.addEventListener("keydown", this.keyEvents);
        window.addEventListener("resize", this.onResize);
        document.addEventListener("fullscreenchange", this.onFullscreenChange);

        try {
            await this.load();
        } catch (e) {
            this.loadingText = e.message || "Failed to load PDF";
            notify({
                type: "error",
                title: "Error",
                text: e.message || "Failed to load PDF",
            });
        }
    },

    beforeUnmount() {
        this.stopAutoScroll();
        this.saveState(true);
        this.io?.disconnect();
        this.pdf?.destroy();
        window.removeEventListener("keydown", this.keyEvents);
        window.removeEventListener("resize", this.onResize);
        document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    },

    methods: {
        async load() {
            const res = await fetch(baseURL + `/api/tab/${this.tabID}`, {
                credentials: "include",
            });

            await checkFetch(res);

            const data = await res.json();
            if (!data.tab) {
                throw new Error("Tab not found");
            }

            this.tab = data.tab;

            // markRaw: pdf.js objects use JS private fields, and Vue's reactive
            // proxy turns access to them into "Cannot read private member #x from
            // an object whose class did not declare it". They must stay raw.
            const document_ = await pdfjs.getDocument({
                url: `${baseURL}/api/tab/${this.tabID}/file?inline=1`,
                withCredentials: true,
                // Served by /api/tab/:id/file with byte-range support, so pdf.js only
                // downloads the parts of a large PDF it actually needs.
                standardFontDataUrl: `${baseURL}/pdfjs/standard_fonts/`,
                cMapUrl: `${baseURL}/pdfjs/cmaps/`,
                cMapPacked: true,
            }).promise;

            this.pdf = markRaw(document_);

            this.totalPages = this.pdf.numPages;
            await this.buildPages();

            this.ready = true;
            this.loadingText = "";

            await this.$nextTick();
            this.measure();
            this.setupObserver();
            this.applyScale(true);

            if (this.currentPage > 1) {
                await this.$nextTick();
                this.gotoPage(this.currentPage, false, true);
            }

            this.saveState();
        },

        /**
         * Create a sized placeholder per page. Sizes come from the page boxes, so
         * the scrollbar is correct before anything is rendered. For huge documents
         * we assume every page has the same size as page one.
         */
        async buildPages() {
            const views = [];

            const readDims = async (num) => {
                const page = await this.pdf.getPage(num);
                const viewport = page.getViewport({ scale: 1 });
                return { baseWidth: viewport.width, baseHeight: viewport.height };
            };

            let uniform = null;

            if (this.totalPages <= 200) {
                for (let num = 1; num <= this.totalPages; num++) {
                    const dims = await readDims(num);
                    views.push({ num, ...dims, width: dims.baseWidth, height: dims.baseHeight, rendered: false });
                }
            } else {
                uniform = await readDims(1);
                for (let num = 1; num <= this.totalPages; num++) {
                    views.push({ num, ...uniform, width: uniform.baseWidth, height: uniform.baseHeight, rendered: false });
                }
            }

            this.pageViews = views;
        },

        setupObserver() {
            this.io?.disconnect();

            // Render a page slightly before it scrolls into view, so scrolling
            // never shows an empty page.
            this.io = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const num = parseInt(entry.target.dataset.page, 10);
                        this.renderPage(num);
                    }
                }
            }, {
                root: this.scroller,
                rootMargin: "1000px 0px",
            });

            for (const wrap of this.pageWraps()) {
                this.io.observe(wrap);
            }
        },

        pageWraps() {
            return Array.from(this.scroller?.querySelectorAll(".page-wrap") || []);
        },

        pageWrapEl(num) {
            return this.scroller?.querySelector(`.page-wrap[data-page="${num}"]`);
        },

        async renderPage(num) {
            const view = this.pageViews[num - 1];
            if (!view || view.rendered || view.rendering) {
                return;
            }

            const canvas = this.canvases[num];
            if (!canvas) {
                return;
            }

            const requestedScale = this.scale;
            view.rendering = true;

            try {
                const page = await this.pdf.getPage(num);
                const viewport = page.getViewport({ scale: requestedScale });

                canvas.width = Math.floor(viewport.width * this.dpr);
                canvas.height = Math.floor(viewport.height * this.dpr);
                canvas.style.width = `${Math.floor(viewport.width)}px`;
                canvas.style.height = `${Math.floor(viewport.height)}px`;

                // The zoom may have changed while the page was loading.
                if (requestedScale !== this.scale) {
                    return;
                }

                const renderTask = page.render({
                    canvasContext: canvas.getContext("2d"),
                    viewport,
                    transform: this.dpr !== 1 ? [this.dpr, 0, 0, this.dpr, 0, 0] : undefined,
                });

                this.renderTasks.set(num, renderTask);

                await renderTask.promise;
                view.rendered = true;
            } catch (e) {
                if (e?.name !== "RenderingCancelledException") {
                    console.error("Failed to render page", num, e);
                }
            } finally {
                view.rendering = false;
                this.renderTasks.delete(num);
            }
        },

        /** Current effective scale, computed from the fit mode when one is active. */
        computeFitScale(fitMode) {
            const first = this.pageViews[0];
            if (!first || !this.scroller) {
                return this.scale;
            }

            const style = getComputedStyle(this.scroller);
            const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            const availableHeight = this.scroller.clientHeight - paddingY - 24;

            if (fitMode === "width") {
                return (this.scroller.clientWidth - 24) / first.baseWidth;
            }
            if (fitMode === "page") {
                return Math.min((this.scroller.clientWidth - 24) / first.baseWidth, availableHeight / first.baseHeight);
            }
            return this.scale;
        },

        /**
         * Apply the current zoom: recompute the fit scale if a fit mode is active,
         * resize every placeholder, then re-render what is on screen.
         */
        applyScale() {
            if (this.fitMode !== "custom") {
                this.scale = Math.min(Math.max(this.computeFitScale(this.fitMode), MIN_SCALE), MAX_SCALE);
            }

            for (const view of this.pageViews) {
                view.width = view.baseWidth * this.scale;
                view.height = view.baseHeight * this.scale;
                view.rendering = false;
                view.rendered = false;
            }

            for (const task of this.renderTasks.values()) {
                task.cancel();
            }
            this.renderTasks.clear();

            this.$nextTick(() => {
                this.setupObserver();
                this.renderVisible();
            });
        },

        renderVisible() {
            const scrollerTop = this.scroller.scrollTop;
            const scrollerBottom = scrollerTop + this.scroller.clientHeight;

            let offset = 0;
            for (const view of this.pageViews) {
                const top = offset;
                const bottom = offset + view.height;
                offset = bottom + 12;

                if (bottom > scrollerTop - 1000 && top < scrollerBottom + 1000) {
                    this.renderPage(view.num);
                }
            }
        },

        setFit(fitMode) {
            this.fitMode = fitMode;
            this.applyScale();
            this.saveState();
        },

        zoom(newScale, fitMode = "custom") {
            this.scale = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
            this.fitMode = fitMode;
            this.applyScale();
            this.saveState();
        },

        zoomIn() {
            this.zoom(this.scale * 1.15);
        },

        zoomOut() {
            this.zoom(this.scale / 1.15);
        },

        setMode(mode) {
            this.mode = mode;
            this.$nextTick(() => this.gotoPage(this.currentPage, false, true));
            this.saveState();
        },

        gotoPage(num, scroll = true, force = false) {
            const target = Math.min(Math.max(num, 1), this.totalPages || 1);
            const changed = target !== this.currentPage;
            this.currentPage = target;

            if (scroll || force) {
                const wrap = this.pageWrapEl(target);
                if (wrap) {
                    // Relative to the scroller's own box: offsetTop would be relative to
                    // the nearest positioned ancestor, which is not the scroller here.
                    const top = wrap.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top +
                        this.scroller.scrollTop - 8;
                    this.scroller.scrollTo({ top: top, behavior: force ? "auto" : "smooth" });
                }
            }

            if (changed || force) {
                this.renderPage(target);
                this.saveState();
            }
        },

        scrollBy(delta) {
            this.scroller.scrollBy({ top: delta, behavior: "auto" });
        },

        onScroll() {
            if (this.pageViews.length === 0) {
                return;
            }

            const reference = this.scroller.scrollTop + this.scroller.clientHeight * 0.25;
            let offset = 0;
            let current = this.currentPage;
            let bestDistance = Infinity;

            for (const view of this.pageViews) {
                const top = offset;
                offset += view.height + 12;
                const distance = Math.abs(top - reference);
                if (reference >= top && reference < offset) {
                    current = view.num;
                    bestDistance = 0;
                    break;
                }
                if (distance < bestDistance) {
                    bestDistance = distance;
                    current = view.num;
                }
            }

            if (current !== this.currentPage) {
                this.currentPage = current;
                this.saveState();
            }
        },

        toggleAutoScroll() {
            if (this.autoScrolling) {
                this.stopAutoScroll();
            } else {
                this.startAutoScroll();
            }
        },

        startAutoScroll() {
            if (this.totalPages === 0) {
                return;
            }

            // Already at the very end: start over from the top.
            const el = this.scroller;
            if (this.endOfTabReached && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
                el.scrollTo({ top: 0, behavior: "auto" });
                this.currentPage = 1;
                this.endOfTabReached = false;
            }

            this.autoScrolling = true;
            this.lastTick = 0;
            this.rafID = requestAnimationFrame(this.autoScrollTick);
        },

        stopAutoScroll() {
            this.autoScrolling = false;
            if (this.rafID) {
                cancelAnimationFrame(this.rafID);
                this.rafID = null;
            }
            this.saveState();
        },

        autoScrollTick(timestamp) {
            if (!this.autoScrolling) {
                return;
            }

            const el = this.scroller;
            if (!this.lastTick) {
                this.lastTick = timestamp;
            }

            // Cap dt so a backgrounded tab does not jump on the next frame.
            const dt = Math.min((timestamp - this.lastTick) / 1000, 0.25);
            this.lastTick = timestamp;

            const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
            if (atEnd) {
                this.endOfTabReached = true;
                this.stopAutoScroll();
                return;
            }

            el.scrollTop = el.scrollTop + this.scrollSpeed * dt;
            this.onScroll();

            this.rafID = requestAnimationFrame(this.autoScrollTick);
        },

        speedUp() {
            this.scrollSpeed = Math.min(this.scrollSpeed + 10, 400);
            this.saveState();
        },

        speedDown() {
            this.scrollSpeed = Math.max(this.scrollSpeed - 10, 5);
            this.saveState();
        },

        toggleNight() {
            this.night = !this.night;
            this.saveState();
        },

        toggleToolbar() {
            this.showToolbar = !this.showToolbar;
        },

        async toggleFullscreen() {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    await this.$refs.viewerRoot.requestFullscreen();
                }
            } catch (e) {
                console.error(e);
            }
        },

        onFullscreenChange() {
            this.fullscreen = document.fullscreenElement === this.$refs.viewerRoot;
            if (this.ready) {
                this.$nextTick(() => {
                    this.measure();
                    this.applyScale();
                });
            }
        },

        /** Fill the space the app's layout leaves for the viewer. */
        measure() {
            const el = this.$refs.viewerRoot;
            if (!el) {
                return;
            }
            const rect = el.getBoundingClientRect();
            this.viewerHeight = Math.max(240, Math.round(window.innerHeight - rect.top));
        },

        onResize() {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => {
                this.measure();
                if (this.fitMode !== "custom") {
                    this.applyScale();
                }
            }, 200);
        },

        async toggleFav() {
            const newFavStatus = !this.tab.fav;

            try {
                const res = await fetch(baseURL + `/api/tab/${this.tabID}/fav`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fav: newFavStatus }),
                });

                if (res.status !== 200) {
                    const data = await res.json();
                    throw new Error(data.message || "Failed to update favorite status");
                }

                this.tab.fav = newFavStatus;
            } catch (e) {
                notify({ text: e.message, type: "error" });
            }
        },

        edit() {
            this.$router.push(`/tab/${this.tabID}/edit/info`);
        },

        download() {
            window.location.href = `${baseURL}/api/tab/${this.tabID}/file?disposition=attachment`;
        },

        openInNewTab() {
            window.open(`${baseURL}/api/tab/${this.tabID}/file?inline=1`, "_blank");
        },

        async deleteTab() {
            if (!confirm(`Delete "${this.tab.title}"? The PDF file is kept in the data folder.`)) {
                return;
            }

            try {
                const res = await fetch(baseURL + `/api/tab/${this.tabID}`, {
                    method: "DELETE",
                    credentials: "include",
                });

                await checkFetch(res);
                notify({ text: "Tab deleted", type: "success" });
                this.$router.push("/");
            } catch (e) {
                generalError(e);
            }
        },

        stateKey() {
            return STORAGE_PREFIX + this.tabID;
        },

        saveState(immediate = false) {
            const write = () => {
                try {
                    localStorage.setItem(this.stateKey(), JSON.stringify({
                        v: STATE_VERSION,
                        page: this.currentPage,
                        scale: this.scale,
                        fitMode: this.fitMode,
                        mode: this.mode,
                        night: this.night,
                        scrollSpeed: this.scrollSpeed,
                        showToolbar: this.showToolbar,
                    }));
                } catch (e) {
                    console.error(e);
                }
            };

            if (immediate) {
                clearTimeout(this.saveStateTimer);
                write();
                return;
            }

            clearTimeout(this.saveStateTimer);
            this.saveStateTimer = setTimeout(write, 400);
        },

        restoreState() {
            const raw = localStorage.getItem(this.stateKey());
            if (!raw) {
                return;
            }

            try {
                const state = JSON.parse(raw);
                if (typeof state.page === "number") {
                    this.currentPage = state.page;
                }
                if (typeof state.scale === "number") {
                    this.scale = state.scale;
                }
                if (typeof state.fitMode === "string") {
                    // "width" from an older version is the old default, not a choice: fall
                    // through to the current default instead of restoring it.
                    const legacyDefault = (state.v ?? 1) < STATE_VERSION && state.fitMode === "width";
                    this.fitMode = legacyDefault ? "page" : state.fitMode;
                }
                if (typeof state.mode === "string") {
                    this.mode = state.mode;
                }
                if (typeof state.night === "boolean") {
                    this.night = state.night;
                }
                if (typeof state.scrollSpeed === "number") {
                    this.scrollSpeed = state.scrollSpeed;
                }
                if (typeof state.showToolbar === "boolean") {
                    this.showToolbar = state.showToolbar;
                }
            } catch (e) {
                console.error(e);
            }
        },
    },
});
</script>

<template>
    <div
        ref="viewerRoot"
        class="pdf-viewer"
        :class='{ night: night, "no-toolbar": !showToolbar, fullscreen: fullscreen }'
        :style='fullscreen ? { height: "100vh" } : (viewerHeight ? { height: viewerHeight + "px" } : {})'
    >
        <div class="pdf-header">
            <h1>{{ tab.title }}</h1>
            <h2 v-if="tab.artist">{{ tab.artist }}</h2>
            <div class="badges">
                <span class="badge bg-secondary">PDF</span>
                <span class="badge bg-secondary" v-if="totalPages">{{ totalPages }} pages</span>
                <span class="badge bg-warning text-dark" v-if="!isPublic">Private</span>
            </div>
        </div>

        <div class="pdf-loading" v-if="!ready">
            {{ loadingText }}
        </div>

        <div class="pdf-scroller" ref="scroller" @scroll="onScroll" v-show="ready">
            <div class="pages">
                <div
                    v-for="view in pageViews"
                    :key="view.num"
                    class="page-wrap"
                    :data-page="view.num"
                    :class='{ "single-page": mode === "page" }'
                    :style='{ width: view.width + "px", height: view.height + "px" }'
                >
                    <canvas :data-page="view.num" :ref="(el) => { if (el) canvases[view.num] = el }"></canvas>
                </div>
            </div>
        </div>

        <div class="pdf-toolbar" :class='{ hidden: !showToolbar }'>
            <button class="btn btn-primary" @click="toggleAutoScroll" :class='{ active: autoScrolling }'>
                <font-awesome-icon :icon='autoScrolling ? ["fas", "pause"] : ["fas", "play"]' />
                {{ autoScrolling ? "Pause" : "Auto-scroll" }}
            </button>

            <div class="speed">
                <font-awesome-icon :icon='["fas", "gauge"]' />
                <input type="range" class="form-range" min="5" max="400" step="5" v-model.number="scrollSpeed" @change="saveState()" />
                <span class="speed-value">{{ speedPercentLabel }}</span>
            </div>

            <div class="pager">
                <button class="btn btn-secondary" @click="gotoPage(currentPage - 1)" :disabled="currentPage <= 1">
                    <font-awesome-icon :icon='["fas", "chevron-left"]' />
                </button>
                <input
                    type="number"
                    class="form-control page-input"
                    min="1"
                    :max="totalPages"
                    v-model.number="currentPage"
                    @change="gotoPage(currentPage)"
                />
                <span class="page-total">/ {{ totalPages }}</span>
                <button class="btn btn-secondary" @click="gotoPage(currentPage + 1)" :disabled="currentPage >= totalPages">
                    <font-awesome-icon :icon='["fas", "chevron-right"]' />
                </button>
            </div>

            <div class="zoomer">
                <button class="btn btn-secondary" @click="zoomOut" title="Zoom out (-)">
                    <font-awesome-icon :icon='["fas", "minus"]' />
                </button>
                <span class="zoom-value">{{ Math.round(scale * 100) }}%</span>
                <button class="btn btn-secondary" @click="zoomIn" title="Zoom in (+)">
                    <font-awesome-icon :icon='["fas", "plus"]' />
                </button>
                <button class="btn btn-secondary" @click="setFit('width')" :class='{ active: fitMode === "width" }'>Fit width</button>
                <button class="btn btn-secondary" @click="setFit('page')" :class='{ active: fitMode === "page" }'>Fit page</button>
            </div>

            <div class="modes">
                <button class="btn btn-secondary" @click="setMode('scroll')" :class='{ active: mode === "scroll" }'>Continuous</button>
                <button class="btn btn-secondary" @click="setMode('page')" :class='{ active: mode === "page" }'>Page</button>
            </div>

            <button class="btn btn-secondary" @click="toggleNight" :class='{ active: night }' title="Night mode (D)">
                <font-awesome-icon :icon='["fas", "moon"]' />
            </button>
            <button class="btn btn-secondary" @click="toggleFullscreen" title="Fullscreen (F)">
                <font-awesome-icon :icon='["fas", "expand"]' />
            </button>
            <button class="btn btn-secondary" @click="download" title="Download">
                <font-awesome-icon :icon='["fas", "download"]' />
            </button>

            <div class="spacer"></div>

            <button class="btn btn-secondary" @click="toggleToolbar" title="Hide toolbar">
                <font-awesome-icon :icon='["fas", "eye-slash"]' />
            </button>
            <button class="btn btn-secondary" v-if="isLoggedIn" @click="edit">
                <font-awesome-icon :icon='["fas", "pen"]' />
                Edit
            </button>
            <button class="btn btn-secondary" @click="toggleFav">
                <font-awesome-icon :icon='tab.fav ? "star" : ["far", "star"]' />
            </button>
            <button class="btn btn-danger" v-if="isLoggedIn" @click="deleteTab">
                <font-awesome-icon :icon='["fas", "trash"]' />
            </button>
        </div>

        <button class="show-toolbar" v-if="!showToolbar" @click="toggleToolbar">
            <font-awesome-icon :icon='["fas", "eye"]' />
        </button>

        <div class="hint" :class='{ hidden: !showToolbar }'>
            Space: auto-scroll &middot; &larr;/&rarr;: page &middot; +/&minus;: zoom &middot; D: night &middot; F: fullscreen
        </div>
    </div>
</template>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.pdf-viewer {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 70px);
    background: #101418;
    overflow: hidden;

    &.fullscreen {
        height: 100vh;
    }

    .pdf-header {
        padding: 8px 16px 0;
        flex-grow: 0;

        h1 {
            font-size: 1.3rem;
            margin: 0;
        }

        h2 {
            font-size: 0.95rem;
            color: $color2-dark;
            margin: 0;
        }

        .badges {
            margin-top: 4px;

            .badge {
                margin-right: 6px;
            }
        }
    }

    .pdf-loading {
        flex-grow: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: $color2-dark;
    }

    .pdf-scroller {
        flex-grow: 1;
        overflow: auto;
        overscroll-behavior: contain;
        background: #0b0e11;
        padding: 12px 0;

        .pages {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
        }

        .page-wrap {
            background: white;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
            position: relative;

            canvas {
                display: block;
            }
        }
    }

    &.night .pdf-scroller .page-wrap canvas {
        filter: invert(0.92) hue-rotate(180deg) contrast(1.05);
    }

    .pdf-toolbar {
        flex-grow: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: $dark1;
        border-top: 1px solid #222;

        &.hidden {
            display: none;
        }

        .speed {
            display: flex;
            align-items: center;
            gap: 6px;

            input[type="range"] {
                width: 120px;
            }

            .speed-value {
                color: $color2-dark;
                font-size: 0.8rem;
                min-width: 58px;
            }
        }

        .pager,
        .zoomer,
        .modes {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .page-input {
            width: 70px;
        }

        .page-total,
        .zoom-value {
            color: $color2-dark;
            font-size: 0.85rem;
        }

        .spacer {
            flex-grow: 1;
        }

        .btn.active {
            outline: 2px solid #b0c5d5;
        }
    }

    .show-toolbar {
        position: absolute;
        right: 12px;
        bottom: 12px;
        background: rgba(49, 49, 198, 0.85);
        border: none;
        color: white;
        border-radius: 50%;
        width: 42px;
        height: 42px;
    }

    .hint {
        flex-grow: 0;
        text-align: center;
        font-size: 0.75rem;
        color: $color2-dark;
        padding: 2px 0 6px;
        background: $dark1;

        &.hidden {
            display: none;
        }
    }
}
</style>
