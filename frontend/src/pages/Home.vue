<script>
import { defineComponent } from "vue";
import { notify } from "@kyvg/vue3-notification";
import { baseURL, getSetting } from "../app.js";
import { isLoggedIn } from "../auth-client.js";
import TabItem from "../components/TabItem.vue";
import PdfPreview from "../components/PdfPreview.vue";

export default defineComponent({
    components: {
        TabItem,
        PdfPreview,
    },

    data() {
        return {
            tabList: [],
            // Total tabs in the library, which can be larger than the loaded page: the API
            // serves the list from an index, so a page is fetched instead of everything.
            totalTabs: 0,
            pageSize: 200,
            loading: false,
            // Remote recents/favorites for the case where the loaded page is truncated.
            remoteRecents: null,
            remoteFavorites: null,
            serverSearchResults: null,
            searchTimer: null,
            ready: false,
            isLoggedIn: false,
            searchQuery: "",
            // progs4u: search what is printed inside the files (FTS5 over the PDF text)
            // instead of only what the tabs are called.
            searchInside: false,
            setting: {},
            recentLimit: 20,
            // progs4u: the tab the preview pane shows. Single click in any list selects it,
            // double click opens it - so browsing a library and judging a page never has to
            // leave (and lose) the list you are working through.
            selectedTab: null,
            // Saved so a return from a tab (or a reload) brings the list back as it was.
            selectedTabId: null,
        };
    },

    async mounted() {
        this.isLoggedIn = await isLoggedIn();
        this.setting = getSetting();

        // Coming back from a tab must not lose the list you were working through.
        try {
            const saved = JSON.parse(sessionStorage.getItem("homeContext") || "null");
            if (saved) {
                this.searchQuery = saved.searchQuery || "";
                this.searchInside = saved.searchInside === true;
                this.selectedTabId = saved.selectedTabId ?? null;
            }
        } catch {
            // a stale or unreadable context is not worth failing the page for
        }

        window.addEventListener("keydown", this.onKeyDown);

        if (!this.isLoggedIn) {
            this.$router.push("/login");
            return;
        }

        try {
            await this.loadTabs(0);
        } catch (error) {
            notify({
                text: error.message,
                type: "error",
            });
        } finally {
            // The page must render even when the tabs API fails (expired session, server
            // error): the columns show their empty state instead of a blank page.
            this.ready = true;
            await this.$nextTick();
            this.restoreSelection();
            this.$refs.searchInput?.focus();
        }
    },

    computed: {
        filteredTabList() {
            if (!this.searchQuery.trim()) return this.tabList;

            // Content results only exist server-side.
            if (this.searchInside) return this.serverSearchResults ?? [];

            // Server-side results when the library is bigger than one page, otherwise the
            // local filter (no request while typing through a fully loaded library).
            if (this.serverSearchResults) return this.serverSearchResults;

            const query = this.searchQuery.trim().toLowerCase();

            return this.tabList.filter((tab) => {
                const title = (tab.title || "").toLowerCase();
                const artist = (tab.artist || "").toLowerCase();
                return title.includes(query) || artist.includes(query);
            });
        },

        favoritedTabs() {
            if (this.remoteFavorites) return this.remoteFavorites;
            return this.tabList.filter((tab) => tab.fav);
        },

        // Tabs the user opened most recently (tracked via lastAccessAt).
        recentTabs() {
            if (this.remoteRecents) return this.remoteRecents;

            const opened = this.tabList
                .filter((tab) => tab.lastAccessAt)
                .sort((a, b) => new Date(b.lastAccessAt).getTime() - new Date(a.lastAccessAt).getTime());
            return opened.slice(0, this.recentLimit);
        },

        /** True when the library holds more tabs than the current page. */
        isTruncated() {
            return this.totalTabs > this.tabList.length;
        },

        groupedTabs() {
            const groups = {};

            for (const tab of this.filteredTabList) {
                const rawArtist = tab.artist || "Unknown Artist";

                // Normalize for grouping (ignore case + trim)
                const key = rawArtist.trim().toLowerCase();

                if (!groups[key]) {
                    groups[key] = {
                        displayName: rawArtist.trim() || "Unknown Artist",
                        tabs: [],
                    };
                }

                groups[key].tabs.push(tab);
            }

            // Sort artists alphabetically
            const sortedArtists = Object.values(groups).sort((a, b) => a.displayName.localeCompare(b.displayName));

            // Sort songs alphabetically inside each artist
            sortedArtists.forEach((group) => {
                group.tabs.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
            });

            return sortedArtists;
        },
    },

    watch: {
        // Debounced so typing does not fire a request per keystroke; a small, fully
        // loaded library never issues a request at all (see search()).
        searchQuery(value) {
            this.saveContext();
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.search(value.trim()), 300);
        },

    },

    methods: {
        /**
         * Fetch one page of the library. `append` continues the list (offset = what is
         * already loaded), otherwise the page replaces it.
         */
        async loadTabs(offset = 0, q = null, append = false) {
            this.loading = true;

            try {
                const params = new URLSearchParams();
                params.set("limit", String(this.pageSize));
                params.set("offset", String(offset));
                if (q) {
                    params.set(this.searchInside ? "text" : "q", q);
                }

                const res = await fetch(`${baseURL}/api/tabs?${params.toString()}`, { credentials: "include" });
                const data = await res.json();

                // The API can return { ok: false } without a tabs array (e.g. an
                // expired session), so guard against assigning undefined.
                const tabs = Array.isArray(data.tabs) ? data.tabs : [];

                if (append) {
                    const known = new Set(this.tabList.map((tab) => tab.id));
                    this.tabList = [...this.tabList, ...tabs.filter((tab) => !known.has(tab.id))];
                } else {
                    this.tabList = tabs;
                }

                if (typeof data.total === "number") {
                    this.totalTabs = data.total;
                } else {
                    this.totalTabs = this.tabList.length;
                }

                await this.loadSideLists();
            } finally {
                this.loading = false;
            }
        },

        /**
         * The recents and favorites columns must stay correct when the library is larger
         * than one page, so they come from their own (small) queries in that case.
         */
        async loadSideLists() {
            const truncated = this.totalTabs > this.tabList.length;

            if (!truncated) {
                this.remoteRecents = null;
                this.remoteFavorites = null;
                return;
            }

            try {
                const [recents, favorites] = await Promise.all([
                    fetch(`${baseURL}/api/tabs?sort=access&order=desc&opened=1&limit=${this.recentLimit}`, { credentials: "include" }).then((res) => res.json()),
                    fetch(`${baseURL}/api/tabs?fav=1&limit=100`, { credentials: "include" }).then((res) => res.json()),
                ]);

                this.remoteRecents = Array.isArray(recents.tabs) ? recents.tabs : [];
                this.remoteFavorites = Array.isArray(favorites.tabs) ? favorites.tabs : [];
            } catch (e) {
                console.error("Failed to load recents/favorites", e);
            }
        },

        /** Search the whole library (only worth a request when the page is truncated). */
        async search(q) {
            // Content search has to run on the server: the text is not in this page's data.
            if (this.totalTabs <= this.tabList.length && !this.searchInside) {
                // Everything is loaded, the local filter is enough and instant.
                this.serverSearchResults = null;
                return;
            }

            if (!q) {
                this.serverSearchResults = null;
                await this.loadTabs(0);
                return;
            }

            this.loading = true;
            try {
                const params = new URLSearchParams({ limit: String(this.pageSize), offset: "0" });
                // `q` matches title/composer/collection/tags, `text` matches the printed page.
                params.set(this.searchInside ? "text" : "q", q);
                const res = await fetch(`${baseURL}/api/tabs?${params.toString()}`, { credentials: "include" });
                const data = await res.json();
                this.serverSearchResults = Array.isArray(data.tabs) ? data.tabs : [];
            } finally {
                this.loading = false;
            }
        },

        async loadMore() {
            await this.loadTabs(this.tabList.length, null, true);
        },

        /** Single click: show the tab in the preview pane, stay in the list. */
        selectTab(tab) {
            this.selectedTab = tab;
            this.selectedTabId = tab.id;
            this.saveContext();
        },

        /** Double click (or Enter): open the tab's viewer. */
        openTab(tab) {
            const target = tab ?? this.selectedTab;
            if (!target) {
                return;
            }
            this.selectedTab = target;
            this.selectedTabId = target.id;
            this.saveContext();
            this.$router.push(`/tab/${target.id}`);
        },

        /**
         * Walk the visible list from the keyboard, so a search can be judged row by row
         * without touching the mouse. The selection follows the arrow keys and the list
         * scrolls to keep it in view.
         */
        moveSelection(step) {
            const list = this.filteredTabList;
            if (list.length === 0) {
                return;
            }
            const current = list.findIndex((tab) => tab.id === this.selectedTabId);
            const next = current === -1
                ? (step > 0 ? 0 : list.length - 1)
                : Math.min(list.length - 1, Math.max(0, current + step));

            this.selectedTab = list[next];
            this.selectedTabId = list[next].id;
            this.saveContext();
            this.$nextTick(() => this.scrollSelectionIntoView(list[next].id));
        },

        scrollSelectionIntoView(id) {
            const row = this.$el?.querySelector(`.tab-item.selected`);
            if (row && typeof row.scrollIntoView === "function") {
                row.scrollIntoView({ block: "nearest" });
            }
        },

        onKeyDown(event) {
            const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

            if (event.key === "ArrowDown") {
                event.preventDefault();
                this.moveSelection(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                this.moveSelection(-1);
            } else if (event.key === "Enter" && this.selectedTabId !== null) {
                // Enter in the search box opens the highlighted tab, which is how a search
                // ends: type, arrow down to hear nothing, Enter.
                this.openTab(this.selectedTab);
            } else if (event.key === "Escape" && typing) {
                this.searchQuery = "";
            }
        },

        /** Re-attach the saved selection id to the tab object once the lists are loaded. */
        restoreSelection() {
            if (this.selectedTabId === null) {
                return;
            }
            const found = [...this.filteredTabList, ...this.tabList, ...this.recentTabs, ...this.favoritedTabs]
                .find((tab) => String(tab.id) === String(this.selectedTabId));
            if (found) {
                this.selectedTab = found;
            }
        },

        saveContext() {
            try {
                sessionStorage.setItem(
                    "homeContext",
                    JSON.stringify({
                        searchQuery: this.searchQuery,
                        searchInside: this.searchInside,
                        selectedTabId: this.selectedTabId,
                    }),
                );
            } catch {
                // private mode / full storage: the feature is a convenience, not a requirement
            }
        },

        handleFavToggled() {
            // Force re-render by creating a new array reference
            this.tabList = [...this.tabList];
        },

        async deleteTab(id, title, artist) {
            if (!confirm(`Are you sure you want to delete ${artist} - ${title}?`)) return;

            try {
                const res = await fetch(baseURL + `/api/tab/${id}`, {
                    method: "DELETE",
                    credentials: "include",
                });

                if (res.status === 200) {
                    this.tabList = this.tabList.filter((tab) => tab.id !== id);

                    notify({
                        text: "Tab deleted successfully",
                        type: "success",
                    });
                } else {
                    const data = await res.json();
                    throw new Error(data.message || "Failed to delete tab");
                }
            } catch (error) {
                notify({
                    text: error.message,
                    type: "error",
                });
            }
        },
    },
});
</script>

<template>
    <div class="container-fluid home-container">
        <div class="row" v-if="ready">
            <!-- Column 1: Tab List with search -->
            <div class="col-md-12 col-lg-4 order-3 order-lg-0 home-col-tablist">
                <div class="search-section mb-3 pe-3 ps-3">
                    <div class="input-group">
                        <span class="input-group-text">
                            <font-awesome-icon icon="magnifying-glass" />
                        </span>

                        <input
                            type="text"
                            class="form-control search-input"
                            v-model="searchQuery"
                            placeholder="Search by title or artist..."
                            ref="searchInput"
                            aria-label="Search tabs"
                        />

                        <button
                            class="input-group-text bg-transparent border-0 cursor-pointer"
                            type="button"
                            @click='searchQuery = ""'
                            v-if="searchQuery"
                            aria-label="Clear search"
                        >
                            ✕
                        </button>
                    </div>

                    <!-- progs4u: the printable content of the files is searchable too -->
                    <div class="form-check form-check-inline ms-1 mt-2">
                        <input
                            class="form-check-input"
                            type="checkbox"
                            id="searchInside"
                            v-model="searchInside"
                            @change="search(searchQuery.trim())"
                        />
                        <label class="form-check-label small text-muted" for="searchInside">
                            search inside the files
                        </label>
                    </div>
                </div>

                <div class="mb-2 ms-3">
                    Total Tabs: {{ totalTabs }}
                    <span v-if="searchQuery" class="text-muted">
                        ({{ filteredTabList.length }} shown)
                    </span>
                    <span v-else-if="isTruncated" class="text-muted">
                        (showing {{ tabList.length }})
                    </span>
                </div>

                <div v-if="isTruncated && !searchQuery" class="mb-3 ms-3">
                    <button class="btn btn-sm btn-outline-secondary" :disabled="loading" @click="loadMore">
                        {{ loading ? "Loading..." : `Load more (${tabList.length} of ${totalTabs})` }}
                    </button>
                </div>

                <template v-if="this.setting.groupByArtist && groupedTabs">
                    <div v-for="group in groupedTabs" :key="group.displayName" class="mb-4 ms-3">
                        <h4>{{ group.displayName }}</h4>

                        <TabItem
                            v-for="tab in group.tabs"
                            :key="tab.id"
                            :tab="tab"
                            :show-artist="false"
                            :selected="selectedTabId === tab.id"
                            @delete="deleteTab"
                            @favToggled="handleFavToggled"
                            @select="selectTab"
                            @open="openTab"
                        />
                    </div>
                </template>

                <template v-else>
                    <TabItem
                        v-for="tab in filteredTabList"
                        :key="tab.id"
                        :tab="tab"
                        :show-artist="true"
                        :selected="selectedTabId === tab.id"
                        @delete="deleteTab"
                        @favToggled="handleFavToggled"
                        @select="selectTab"
                        @open="openTab"
                    />
                </template>

                <div
                    v-if="filteredTabList.length === 0 && searchQuery"
                    class="empty-state text-center py-5 mb-4 fs-5"
                >
                    <p class="text-muted">No tabs found for "{{ searchQuery }}"</p>

                    <button class="btn btn-sm btn-outline-secondary" @click='searchQuery = ""'>
                        Clear search
                    </button>
                </div>
            </div>

            <!--
                Right region: recents and favourites keep the top half, the preview pane takes
                the bottom half. Judging a page is what browsing this library is for, so it sits
                next to the lists instead of behind a navigation.
            -->
            <div class="col-md-12 col-lg-8 order-1 order-lg-0 right-region">
                <div class="row g-0 right-top">
                    <!-- Column 2: Recent Tabs -->
                    <div class="col-md-12 col-lg-6 box box-left">
                        <div class="ms-3 mb-2">
                            <h4>Recent Tabs</h4>
                        </div>

                        <div v-if="recentTabs.length === 0" class="empty-msg">
                            No Recent Tabs
                        </div>

                        <TabItem
                            v-for="tab in recentTabs"
                            :key="`recent-${tab.id}`"
                            :tab="tab"
                            :show-artist="true"
                            :selected="selectedTabId === tab.id"
                            @delete="deleteTab"
                            @favToggled="handleFavToggled"
                            @select="selectTab"
                            @open="openTab"
                        />
                    </div>

                    <!-- Column 3: Fav Tabs -->
                    <div class="col-md-12 col-lg-6 box box-right">
                        <div class="ms-3 mb-2">
                            <h4>Favorite Tabs</h4>
                        </div>

                        <div v-if="favoritedTabs.length === 0" class="empty-msg">
                            No Favorite Tabs
                        </div>

                        <TabItem
                            v-for="tab in favoritedTabs"
                            :key="`fav-${tab.id}`"
                            :tab="tab"
                            :show-artist="true"
                            :selected="selectedTabId === tab.id"
                            @delete="deleteTab"
                            @favToggled="handleFavToggled"
                            @select="selectTab"
                            @open="openTab"
                        />
                    </div>
                </div>

                <div class="preview-pane">
                    <PdfPreview :tab="selectedTab" />
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/vars.scss";

.artist-group {
    h3 {
        margin-bottom: 8px;
        margin-top: 20px;
    }
}

h4 {
    color: $color2-dark;
}

// The right region is one column of two halves: the two list boxes on top, the preview
// below. The boxes keep their own scrolling; the whole region is the viewport height.
// The list scrolls inside its own column, so the preview next to it stays in view while
// working through results instead of scrolling away with the page.
.home-col-tablist {
    .desktop & {
        height: calc(100vh - 160px);
        overflow-y: auto;
    }
}

.right-region {
    display: flex;
    flex-direction: column;

    .desktop & {
        height: calc(100vh - 160px);
        gap: 12px;
    }
}

.right-top {
    flex: 0 0 calc(50% - 6px);
    min-height: 0;
    overflow: hidden;

    .box {
        height: 100%;
        overflow-y: auto;
    }
}

.preview-pane {
    flex: 1 1 50%;
    min-height: 0;
    display: flex;

    > * {
        width: 100%;
        min-height: 0;
    }

    .mobile & {
        height: 320px;
    }
}

.box {
    background-color: rgba(0, 0, 0, 0.16);
    padding: 25px;

    // Not Mobile
    .desktop & {
        height: 100%;

        &.box-left {
            border-radius: 25px 0 0 25px;
            border-right: 1px solid rgba(255, 255, 255, 0.04);
        }

        &.box-right {
            border-radius: 0 25px 25px 0;
        }
    }

    .mobile & {
        margin-bottom: 25px;
    }
}

.empty-msg {
    text-align: center;
    color: $color2-dark;
    font-size: 1.1rem;
    margin-top: 20px;
}

.desktop .home-container {
    padding-right: 26px;
}
</style>
