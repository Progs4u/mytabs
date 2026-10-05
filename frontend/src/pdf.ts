/**
 * progs4u fork: helpers for tabs that are viewed as documents instead of scores.
 *
 * Everything that is not an AlphaTab score (currently just PDF) is opened by
 * `PdfTab.vue` at /pdf/:id instead of the AlphaTab player at /tab/:id. The router
 * asks this module which page a tab belongs to, and PdfTab.vue reuses the same
 * /api/tab/:id metadata as the player, so title/artist/fav/public keep working.
 */

import { baseURL } from "./app.js";

import { isPdfExt } from "../../backend/common.js";

export function isPdfTab(tab: { filename?: string } | null | undefined): boolean {
    if (!tab || typeof tab.filename !== "string") {
        return false;
    }
    return isPdfExt(tab.filename.split(".").pop() || "");
}

/** Tabs whose format we already resolved, so the route guard asks the API only once. */
const viewerCache = new Map<string, boolean>();

/**
 * Should this tab open in the PDF/document viewer?
 * Never throws: if the API call fails, the normal player page shows the error.
 */
export async function tabUsesViewer(id: string): Promise<boolean> {
    const cached = viewerCache.get(id);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const res = await fetch(baseURL + `/api/tab/${id}`, {
            credentials: "include",
        });

        if (!res.ok) {
            return false;
        }

        const data = await res.json();
        const result = isPdfTab(data.tab);
        viewerCache.set(id, result);
        return result;
    } catch (e) {
        console.error("Failed to detect tab format", e);
        return false;
    }
}

export function forgetViewerCache(id: string): void {
    viewerCache.delete(id);
}
