import { expect, test } from "./fixtures.ts";
import type { Page } from "./fixtures.ts";
import * as fs from "node:fs";
import { login, waitForDemoTab } from "./helpers.ts";

/**
 * How the PDF viewer opens: fitted to the page, so a sheet of music is visible whole instead
 * of having its bottom (the next system) cut off. Uploads a real one-page PDF and drives the
 * actual viewer.
 */

const PREVIEW_PDF = new URL("./fixtures/preview-sample.pdf", import.meta.url).pathname;

/**
 * Upload the fixture as a new tab and return its id. Uploaded through `page.request`, which
 * shares the browser session - the plain `request` fixture is unauthenticated.
 */
async function uploadPdf(page: Page): Promise<string> {
    const res = await page.request.post("/api/new-tab", {
        multipart: {
            file: {
                name: "E2E Fit Page.pdf",
                mimeType: "application/pdf",
                buffer: fs.readFileSync(PREVIEW_PDF),
            },
            title: "E2E Fit Page",
            artist: "E2E",
        },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.id).toBeTruthy();
    return String(data.id);
}

function pageWrapHeight(page: Page): Promise<number> {
    return page.evaluate(() => {
        const wrap = document.querySelector(".pdf-scroller .page-wrap") as HTMLElement | null;
        return wrap ? wrap.getBoundingClientRect().height : 0;
    });
}

function scrollerHeight(page: Page): Promise<number> {
    return page.evaluate(() => {
        const scroller = document.querySelector(".pdf-scroller") as HTMLElement | null;
        return scroller ? scroller.clientHeight : 0;
    });
}

test.describe("pdf viewer defaults", () => {
    test("opens fitted to the page, not to the width", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        const id = await uploadPdf(page);

        await page.goto(`/pdf/${id}`);
        await expect(page.locator(".pdf-scroller")).toBeVisible();
        await expect(page.locator(".pdf-scroller .page-wrap").first()).toBeVisible();

        await expect(page.locator('button:has-text("Fit page")')).toHaveClass(/active/);
        await expect(page.locator('button:has-text("Fit width")')).not.toHaveClass(/active/);

        // Fit page means the page fits: it is not taller than the scroller.
        const wrap = await pageWrapHeight(page);
        const scroller = await scrollerHeight(page);
        expect(wrap).toBeGreaterThan(0);
        expect(wrap).toBeLessThanOrEqual(scroller + 2);
    });

    test("a deliberate fit width is bigger, and is remembered", async ({ page, request }) => {
        await waitForDemoTab(request);
        await login(page);
        const id = await uploadPdf(page);

        await page.goto(`/pdf/${id}`);
        await expect(page.locator(".pdf-scroller .page-wrap").first()).toBeVisible();
        const fittedToPage = await pageWrapHeight(page);

        await page.locator('button:has-text("Fit width")').click();
        await expect(page.locator('button:has-text("Fit width")')).toHaveClass(/active/);

        const fittedToWidth = await pageWrapHeight(page);
        expect(fittedToWidth).toBeGreaterThan(fittedToPage);

        // A choice made now is kept (only the pre-change default is ignored on restore).
        await page.waitForTimeout(700); // the state write is debounced
        await page.reload();
        await expect(page.locator('button:has-text("Fit width")')).toHaveClass(/active/);
    });
});
