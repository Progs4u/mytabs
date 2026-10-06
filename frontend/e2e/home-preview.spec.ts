import { expect, test } from "./fixtures.ts";
import type { Page } from "./fixtures.ts";
import { login, waitForDemoTab } from "./helpers.ts";

/**
 * The library's preview pane: single click previews a tab in place, double click opens it,
 * and the list you are working through survives the trip. Asserted against a real one-page
 * PDF (fixtures/preview-sample.pdf, page 1 of a score) so pdf.js actually renders.
 */

const PREVIEW_PDF = new URL("./fixtures/preview-sample.pdf", import.meta.url).pathname;

interface MockTab {
    id: string;
    title: string;
    artist: string;
}

const LIBRARY: MockTab[] = [
    { id: "101", title: "Asturias Leyenda", artist: "Isaac Albeniz" },
    { id: "102", title: "BWV 401", artist: "J.S Bach" },
    { id: "103", title: "Vidalita con variaciones", artist: "Agustin Barrios Mangore" },
];

/** A small PDF library, with the file endpoints served from a real PDF fixture. */
async function mockLibrary(page: Page, tabs: MockTab[]): Promise<void> {
    const withMeta = tabs.map((tab) => ({
        ...tab,
        filename: "tab.pdf",
        originalFilename: `${tab.id}.pdf`,
        pageCount: 2,
        collection: "classclef",
        tags: ["source:classclef"],
        arranger: "",
        source: "classclef",
        createdAt: "2026-10-06T00:00:00.000Z",
        public: false,
        fav: false,
    }));

    await page.route(/\/api\/tabs(\?.*)?$/, (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: true, tabs: withMeta, total: withMeta.length, limit: 200, offset: 0, hasMore: false }),
        }));

    await page.route(/\/api\/tab\/\d+(\?.*)?$/, (route) => {
        const id = route.request().url().match(/\/api\/tab\/(\d+)/)?.[1];
        const tab = withMeta.find((candidate) => candidate.id === id);
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: true, tab, audioList: [], youtubeList: [] }),
        });
    });

    await page.route(/\/api\/tab\/\d+\/file/, (route) =>
        route.fulfill({
            contentType: "application/pdf",
            path: PREVIEW_PDF,
        }));
}

function row(page: Page, title: string) {
    return page.locator(".tab-item", { hasText: title }).locator("a.info");
}

test.describe("library preview pane", () => {
    test("starts empty and asks for a click", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        await mockLibrary(page, LIBRARY);
        await page.goto("/");

        await expect(page.locator(".pdf-preview .preview-empty")).toBeVisible();
        await expect(page.locator(".tab-item.selected")).toHaveCount(0);
    });

    test("a single click previews the tab and stays on the list", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        await mockLibrary(page, LIBRARY);
        await page.goto("/");

        await row(page, "Asturias Leyenda").click();

        await expect(page.locator(".tab-item.selected")).toHaveCount(1);
        await expect(page.locator(".tab-item.selected")).toContainText("Asturias Leyenda");
        await expect(page.locator(".pdf-preview .preview-title")).toHaveText("Asturias Leyenda");
        await expect(page.locator(".pdf-preview .preview-sub")).toContainText("Isaac Albeniz");

        // The point of the pane: the list is still there, and page 1 is rendered in it.
        expect(new URL(page.url()).pathname).toBe("/");
        await expect(page.locator(".home-col-tablist")).toBeVisible();
        await expect(page.locator(".pdf-preview canvas")).toBeVisible();

        const canvas = await page.locator(".pdf-preview canvas").evaluate((el: HTMLCanvasElement) => ({
            width: el.width,
            height: el.height,
        }));
        expect(canvas.width).toBeGreaterThan(100);
        expect(canvas.height).toBeGreaterThan(100);
    });

    test("double click opens the viewer", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        await mockLibrary(page, LIBRARY);
        await page.goto("/");

        await row(page, "BWV 401").dblclick();

        await expect(page).toHaveURL(/\/pdf\/102$/);
    });

    test("arrow keys walk the list and the preview follows", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        await mockLibrary(page, LIBRARY);
        await page.goto("/");

        await row(page, "Asturias Leyenda").click();
        await expect(page.locator(".pdf-preview .preview-title")).toHaveText("Asturias Leyenda");

        await page.keyboard.press("ArrowDown");
        await expect(page.locator(".pdf-preview .preview-title")).toHaveText("BWV 401");
        await expect(page.locator(".tab-item.selected")).toContainText("BWV 401");

        await page.keyboard.press("ArrowUp");
        await expect(page.locator(".pdf-preview .preview-title")).toHaveText("Asturias Leyenda");
    });

    test("the list and its search survive a trip into a tab", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        await mockLibrary(page, LIBRARY);
        await page.goto("/");

        await page.fill(".search-input", "Bach");
        await page.waitForTimeout(400);

        await row(page, "BWV 401").dblclick();
        await expect(page).toHaveURL(/\/pdf\/102$/);

        await page.goBack();
        await expect(page.locator(".search-input")).toHaveValue("Bach");
        await expect(page.locator(".tab-item.selected")).toContainText("BWV 401");
    });
});
