<script>
import { defineComponent } from "vue";
import { notify } from "@kyvg/vue3-notification";
import { baseURL, getSetting } from "../app.js";
import { isLoggedIn } from "../auth-client.js";
import TabItem from "../components/TabItem.vue";

export default defineComponent({
    components: {
        TabItem,
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
            setting: {},
            recentLimit: 20,
        };
    },

    async mounted() {
        this.isLoggedIn = await isLoggedIn();
        this.setting = getSetting();

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
            this.$refs.searchInput?.focus();
        }
    },

    computed: {
        filteredTabList() {
            if (!this.searchQuery.trim()) return this.tabList;

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
                    params.set("q", q);
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
            if (this.totalTabs <= this.tabList.length) {
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
                const params = new URLSearchParams({ limit: String(this.pageSize), offset: "0", q });
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
                            @delete="deleteTab"
                            @favToggled="handleFavToggled"
                        />
                    </div>
                </template>

                <template v-else>
                    <TabItem
                        v-for="tab in filteredTabList"
                        :key="tab.id"
                        :tab="tab"
                        :show-artist="true"
                        @delete="deleteTab"
                        @favToggled="handleFavToggled"
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

            <!-- Column 2: Recent Tabs -->
            <div class="col-md-12 col-lg-4 order-1 order-lg-0 box box-left">
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
                    @delete="deleteTab"
                    @favToggled="handleFavToggled"
                />
            </div>

            <!-- Column 3: Fav Tabs -->
            <div class="col-md-12 col-lg-4 order-2 order-lg-0 box box-right">
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
                    @delete="deleteTab"
                    @favToggled="handleFavToggled"
                />
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

.box {
    background-color: rgba(0, 0, 0, 0.16);
    padding: 25px;

    // Not Mobile
    .desktop & {
        position: sticky;
        top: 20px;
        align-self: flex-start;
        height: calc(100vh - 160px);
        overflow-y: auto;

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
