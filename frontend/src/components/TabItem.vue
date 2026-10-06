<script>
import { defineComponent } from "vue";
import { notify } from "@kyvg/vue3-notification";
import { baseURL } from "../app.js";
import { isPdfTab } from "../pdf.js";

export default defineComponent({
    props: {
        tab: {
            type: Object,
            required: true,
        },
        showArtist: {
            type: Boolean,
            default: true,
        },
    },

    emits: ["delete", "favToggled"],

    methods: {
        isPdfTab,
        handleEdit() {
            this.$router.push(`/tab/${this.tab.id}/edit/info`);
        },

        handleDelete() {
            this.$emit("delete", this.tab.id, this.tab.title, this.tab.artist);
        },

        async toggleFav() {
            const newFavStatus = !this.tab.fav;

            try {
                const res = await fetch(baseURL + `/api/tab/${this.tab.id}/fav`, {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        fav: newFavStatus,
                    }),
                });

                if (res.status === 200) {
                    this.tab.fav = newFavStatus;
                    this.$emit("favToggled");
                } else {
                    const data = await res.json();
                    throw new Error(data.message || "Failed to update favorite status");
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
    <div class="tab-item rounded">
        <button
            class="fav-btn"
            @click="toggleFav"
            :class='{ "fav-active": tab.fav }'
        >
            <font-awesome-icon
                :icon='tab.fav ? "star" : ["far", "star"]'
            />
        </button>

        <router-link class="info" :to="`/tab/${tab.id}`">
            <div class="title">
                {{ tab.title }}
                <!-- progs4u: mark document tabs so PDFs are distinguishable in lists -->
                <span class="format-badge" v-if="isPdfTab(tab)">PDF</span>
            </div>
            <div class="artist" v-if="showArtist">{{ tab.artist }}</div>
            <!-- progs4u: which collection (pack) a tab came from, and who arranged it -->
            <div class="tab-meta" v-if="tab.collection || tab.arranger">
                <span class="meta-chip" v-if="tab.collection">{{ tab.collection }}</span>
                <span class="meta-chip arranger" v-if="tab.arranger">arr. {{ tab.arranger }}</span>
            </div>
        </router-link>

        <div class="btn-group action-buttons" role="group" aria-label="Tab actions">
            <button class="btn btn-sm btn-secondary" @click="handleEdit" aria-label="Edit">
                <font-awesome-icon icon="pen" />
            </button>
            <button class="btn btn-sm btn-danger" @click="handleDelete" aria-label="Delete">
                <font-awesome-icon icon="trash" />
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/vars.scss";

.tab-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;

    .meta-chip {
        font-size: 10px;
        line-height: 1.4;
        padding: 1px 6px;
        border-radius: 8px;
        background-color: rgba(0, 0, 0, 0.07);
        color: #666;

        &.arranger {
            background-color: rgba(0, 0, 0, 0.04);
            font-style: italic;
        }
    }
}

.tab-item {
    display: flex;
    transition: background-color 0.1s;
    padding: 10px;

    &:hover {
        background-color: rgba(0, 0, 0, 0.05);
    }

    .fav-btn {
        background: none;
        border: none;
        font-size: 14px;
        color: #9e9e9e;
        cursor: pointer;
        padding: 0;
        margin-right: 12px;
        align-self: center;
        transition: color 0.2s;

        &:hover {
            color: #ffa500;
        }

        &.fav-active {
            color: #ffa500;
        }
    }

    .info {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;

        .title {
            font-size: 16px;

            .format-badge {
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.04em;
                vertical-align: middle;
                padding: 2px 5px;
                margin-left: 6px;
                border: 1px solid $color2-dark;
                border-radius: 3px;
                color: $color2-dark;
            }
        }

        .artist {
            font-size: 13px;
            color: $color2-dark;
        }
    }

    button {
        align-self: center;
    }
}
</style>
