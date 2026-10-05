import { serve, ServerType } from "@hono/node-server";
import { Context, Hono } from "@hono/hono";
import * as fs from "@std/fs";
import { auth, checkLogin, getCurrentSession, isFinishSetup, isLoggedIn } from "./auth.ts";
import { SignUpSchema, SyncRequestSchema, UpdateTabFavSchema, UpdateTabInfoSchema, YoutubeAddDataSchema } from "./zod.ts";
import { db, hasUser, isInitDB, kv, migrate } from "./db.ts";
import { cors } from "@hono/hono/cors";
import { serveStatic } from "@hono/hono/deno";
import { appVersion, checkFilename, dataDir, devOriginList, getFrontendDir, getSourceDir, host, isDemoMode, isDev, port, start, tabDir } from "./util.ts";
import * as path from "@std/path";
import { isPdfExt, looksLikePdf, parseTitleArtistFromFilename, supportedAudioFormatList, supportedFormatList } from "./common.ts";
import { parseRangeHeader, PDF_MIME, readRange } from "./pdf.ts";
import {
    addAudio,
    addYoutube,
    checkTabExists,
    createTab,
    deleteTab,
    ensureTabIndex,
    fixMissingTab,
    getAllTabs,
    getConfigJSON,
    getTab,
    getTabFilePath,
    getTabFolderPath,
    getTabFullFilePath,
    getTabs,
    recordTabAccess,
    removeAudio,
    removeYoutube,
    replaceTab,
    updateAudio,
    updateConfigJSON,
    updateTab,
    updateTabFav,
    updateYoutube,
} from "./tab.ts";
import { ZodError } from "zod";
import sanitize from "sanitize-filename";
import "@std/dotenv/load";
import { socketIO } from "./socket.ts";
import * as cheerio from "cheerio";
import { getSeparateJob, isModelInstalled, isOrtInstalled, isSeparateBusy, startMute, startSeparate } from "./separate.ts";

let httpServer: ServerType;

export async function main() {
    console.log(`It's MyTabs v${appVersion}`);

    if (isInitDB()) {
        console.log("Database initialized.");
    }

    await migrate();

    const frontendDir = getFrontendDir();

    if (!Deno.build.standalone) {
        // Check if the frontend directory exists
        // If dev, allow not to exist, but create it
        // If prod, check if it exists, if not, exit
        if (!fs.existsSync(frontendDir)) {
            if (isDev()) {
                console.error("You need to build the frontend first. Run `deno task build`.");
            } else {
                console.error(`${frontendDir} does not exist.`);
                console.error(`Please run \`deno task setup\` to build ${frontendDir}`);
            }
            Deno.exit(1);
        }
    }

    // Read index.html content
    const indexHTMLContent = await Deno.readTextFile(path.join(frontendDir, "index.html"));

    // Inject demo mode flag using cheerio
    const $ = cheerio.load(indexHTMLContent);
    $("head").append(`<script id="app-config" type="application/json">${JSON.stringify({ isDemo: isDemoMode })}</script>`);
    const indexHTML = $.html();

    if (isDemoMode) {
        console.warn("Running in DEMO MODE.");
    }

    const app = new Hono();

    httpServer = serve({
        fetch: app.fetch,
        port,
        hostname: host,
    }, (info) => {
        let address = info.address;
        if (address == "0.0.0.0") {
            address = "localhost";
        }

        // Print DATA_DIR so it's visible on startup
        console.log(`Data Dir:`, dataDir);

        const url = `http://${address}:${info.port}`;
        console.log(`Server running on ${url}`);

        // progs4u: build/refresh the tab index in the background once the server is
        // listening (~7 s for 3 000 tabs). Requests arriving meanwhile await the same
        // pass instead of triggering a second scan.
        ensureTabIndex().then((result) => {
            console.log(`Tab index ready: ${result.total} tabs (${result.indexed} added, ${result.removed} removed)`);
        }).catch((e) => {
            console.error("Failed to build the tab index:", e);
        });

        const launchBrowser = Deno.env.get("MYTABS_LAUNCH_BROWSER");

        if (Deno.build.standalone) {
            if (launchBrowser !== "false") {
                start(url);
            }
        }
    });

    // Socket Controller
    const io = socketIO(httpServer);

    // CORS for development
    if (isDev()) {
        app.use(
            "/api/*",
            cors({
                credentials: true,
                origin: devOriginList,
            }),
        );
    }

    // Better-Auth routes
    app.all("/api/auth/*", (c) => {
        return auth.handler(c.req.raw);
    });

    // Is Disable Sign Up
    app.get("/api/is-finish-setup", (c) => {
        return c.json(isFinishSetup());
    });

    // Register Admin account
    app.post("/register", async (c) => {
        try {
            if (hasUser()) {
                return c.json({ error: "User already exists" }, 400);
            }

            const body = SignUpSchema.parse(await c.req.json());

            const data = await auth.api.signUpEmail({
                body,
            });

            return c.json(data);
        } catch (e) {
            if (e instanceof Error) {
                return c.json({ error: e.message }, 400);
            } else {
                return c.json({ error: "Unknown error" }, 400);
            }
        }
    });

    // New Tab
    app.post("/api/new-tab", async (c) => {
        try {
            await checkLogin(c);

            const form = await c.req.formData();
            const file = form.get("file");

            if (!(file instanceof File)) {
                throw new Error("No file uploaded");
            }

            // Check file ext if in supportedFormatList
            const fileName = file.name;
            const ext = fileName.split(".").pop()?.toLowerCase();
            if (!ext) {
                throw new Error("File has no extension");
            }

            if (!supportedFormatList.includes(ext)) {
                throw new Error("Unsupported file format: " + ext);
            }

            let title = form.get("title") || fileName;
            let artist = form.get("artist") || "";

            // Check title and artist type is string
            if (typeof title !== "string" || typeof artist !== "string") {
                throw new Error("Invalid title or artist");
            }

            title = title.trim();
            artist = artist.trim();

            const arrayBuffer = await file.arrayBuffer();

            // progs4u: a PDF is a viewer file, not an AlphaTab score, so there is no
            // score metadata to read. Validate the magic bytes and fall back to
            // "Artist - Title.pdf" when the client sent no title/artist.
            if (isPdfExt(ext)) {
                if (!looksLikePdf(new Uint8Array(arrayBuffer))) {
                    throw new Error("File does not look like a PDF");
                }
                const parsed = parseTitleArtistFromFilename(fileName);
                if (title === fileName) {
                    title = parsed.title;
                }
                if (artist === "") {
                    artist = parsed.artist;
                }
            }

            let id = await createTab(new Uint8Array(arrayBuffer), ext, title, artist, fileName);

            return c.json({
                ok: true,
                id,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Create Empty Tab
    app.post("/api/new-tab/template/:type", async (c) => {
        try {
            await checkLogin(c);

            const templateTypeList: Record<string, string> = {
                bass: "./extra/empty-bass.gp",
                guitar: "./extra/empty-guitar.gp",
            };

            const type = c.req.param("type");
            const srcDir = getSourceDir();
            const rel = templateTypeList[type];
            if (!rel) {
                return c.json({
                    ok: false,
                    msg: "Template not found",
                }, 400);
            }

            const templatePath = path.join(srcDir, rel);
            const bytes = await Deno.readFile(templatePath);
            const ext = templatePath.split(".").pop()?.toLowerCase() || "gp";
            const title = "Empty Tab";
            const artist = "";

            const id = await createTab(bytes, ext, title, artist, path.basename(templatePath));

            // Append the id to the title
            await updateConfigJSON(id, async (config) => {
                config.tab.title += " #" + id;
            });

            return c.json({
                ok: true,
                id,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Get Tab List
    //
    // progs4u: served from the SQLite tab index with paging and server-side search, so the
    // response size and the work per request no longer scale with the library size.
    //   ?limit=100&offset=0&q=bach&sort=created|title|artist|access&order=desc&fav=1&opened=1
    //   ?limit=0            -> everything (escape hatch; costs one row per tab)
    //   ?reindex=1          -> rebuild the index from the tab directory first
    // The response keeps `tabs` and adds `total` / `limit` / `offset` / `hasMore`.
    app.get("/api/tabs", async (c) => {
        try {
            await checkLogin(c);

            if (c.req.query("reindex") === "1") {
                const result = await ensureTabIndex(true);
                console.log(`Tab index rebuilt: ${result.total} tabs (${result.indexed} added, ${result.removed} removed)`);
            }

            const DEFAULT_LIMIT = 200;
            const MAX_LIMIT = 1000;

            const rawLimit = c.req.query("limit");
            let limit = DEFAULT_LIMIT;
            if (rawLimit !== undefined) {
                const parsed = parseInt(rawLimit, 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    limit = parsed === 0 ? 0 : Math.min(parsed, MAX_LIMIT);
                }
            }

            const rawOffset = c.req.query("offset");
            const parsedOffset = rawOffset === undefined ? 0 : parseInt(rawOffset, 10);
            const offset = !isNaN(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

            const sortParam = c.req.query("sort");
            const sort = sortParam === "title" || sortParam === "artist" || sortParam === "access" || sortParam === "created" ? sortParam : "created";
            const order = c.req.query("order") === "asc" ? "asc" : "desc";

            const result = await getTabs({
                limit,
                offset,
                q: c.req.query("q") || "",
                fav: c.req.query("fav") === "1",
                opened: c.req.query("opened") === "1",
                sort,
                order,
            });

            return c.json({
                ok: true,
                tabs: result.tabs,
                total: result.total,
                limit,
                offset,
                hasMore: limit > 0 && offset + result.tabs.length < result.total,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Get Tab
    app.get("/api/tab/:id", async (c) => {
        try {
            const id = c.req.param("id");

            let config = await getConfigJSON(id);
            if (!config) {
                throw new Error("Config.json not found");
            }

            if (!config.tab.public) {
                await checkLogin(c);
            }

            config = await fixMissingTab(config);

            const filePath = (await isLoggedIn(c)) ? getTabFullFilePath(config.tab) : "";

            // Record the last time this tab was opened so the home page can show
            // a "recent tabs" list.
            await recordTabAccess(id);

            return c.json({
                ok: true,
                showOpenButtons: Deno.build.standalone && Deno.build.os === "windows",
                tab: config.tab,
                youtubeList: config.youtube,
                audioList: config.audio,
                filePath,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Edit Tab
    app.post("/api/tab/:id", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const body = await c.req.json();
            const data = UpdateTabInfoSchema.parse(body);

            const tab = await getTab(id);
            await updateTab(tab, data);
            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Update Tab Favorite Status
    app.post("/api/tab/:id/fav", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const body = await c.req.json();
            const data = UpdateTabFavSchema.parse(body);

            const tab = await getTab(id);
            await updateTabFav(tab, data);
            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Replace Tab File
    app.post("/api/tab/:id/replace", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const tab = await getTab(id);

            const form = await c.req.formData();
            const file = form.get("file");

            if (!(file instanceof File)) {
                throw new Error("No file uploaded");
            }

            // Check file ext if in supportedFormatList
            const fileName = file.name;
            const ext = fileName.split(".").pop()?.toLowerCase();
            if (!ext) {
                throw new Error("File has no extension");
            }

            if (!supportedFormatList.includes(ext)) {
                throw new Error("Unsupported file format: " + ext);
            }

            const arrayBuffer = await file.arrayBuffer();
            await replaceTab(tab, new Uint8Array(arrayBuffer), ext, fileName);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Delete Tab
    app.delete("/api/tab/:id", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            await deleteTab(id);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Add Audio
    app.post("/api/tab/:id/audio", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const tab = await getTab(id);

            const form = await c.req.formData();
            const file = form.get("file");

            if (!(file instanceof File)) {
                throw new Error("No file uploaded");
            }

            const fileName = file.name;
            const ext = fileName.split(".").pop()?.toLowerCase();
            if (!ext) {
                throw new Error("File has no extension");
            }

            if (!supportedAudioFormatList.includes(ext)) {
                throw new Error("Unsupported file format: " + ext);
            }

            const arrayBuffer = await file.arrayBuffer();
            await addAudio(tab, new Uint8Array(arrayBuffer), fileName);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Save Audio (Metadata only)
    app.post("/api/tab/:id/audio/:filename", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const body = await c.req.json();
            const data = SyncRequestSchema.parse(body);

            const tab = await getTab(id);
            const filename = c.req.param("filename");

            await updateAudio(tab, filename, data);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Remove Audio
    app.delete("/api/tab/:id/audio/:filename", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const tab = await getTab(id);
            const filename = c.req.param("filename");
            await removeAudio(tab, filename);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Separate Audio into Stems (bass / drums / guitar)
    app.post("/api/tab/:id/audio/:filename/separate", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const filename = c.req.param("filename");
            checkFilename(filename);

            const tab = await getTab(id);
            const sourcePath = path.join(tabDir, id, filename);

            if (!await fs.exists(sourcePath)) {
                throw new Error("Audio file not found");
            }

            let downloadModel = false;
            const body = await c.req.json().catch(() => ({}));
            if (typeof body === "object" && body !== null) {
                downloadModel = (body as { downloadModel?: unknown }).downloadModel === true;
            }

            startSeparate(tab.id, filename, sourcePath, downloadModel);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Mute a stem in an audio file (produce a mix with bass / guitar removed)
    app.post("/api/tab/:id/audio/:filename/mute", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const filename = c.req.param("filename");
            checkFilename(filename);

            const tab = await getTab(id);
            const sourcePath = path.join(tabDir, id, filename);

            if (!await fs.exists(sourcePath)) {
                throw new Error("Audio file not found");
            }

            const body = await c.req.json().catch(() => ({}));
            const stem = typeof body === "object" && body !== null ? (body as { stem?: unknown }).stem : undefined;
            if (stem !== "bass" && stem !== "drums" && stem !== "guitar") {
                throw new Error("Invalid stem");
            }
            const downloadModel = typeof body === "object" && body !== null ? (body as { downloadModel?: unknown }).downloadModel === true : false;

            // Avoid overwriting an existing file, e.g. a previous mute output.
            const base = path.parse(filename).name;
            let outputPath = path.join(tabDir, id, `${base}_muted-${stem}.ogg`);
            while (await fs.exists(outputPath)) {
                const parsed = path.parse(outputPath);
                outputPath = path.join(parsed.dir, `new_${parsed.name}${parsed.ext}`);
            }

            startMute(tab.id, filename, sourcePath, stem, outputPath, downloadModel);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Separate Audio Status (used by the UI to poll progress)
    app.get("/api/separate/status", async (c) => {
        try {
            await checkLogin(c);
            const job = getSeparateJob();
            return c.json({
                ok: true,
                busy: isSeparateBusy(),
                modelInstalled: isModelInstalled(),
                ortInstalled: isOrtInstalled(),
                job,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Serve audio file
    app.get("/api/tab/:id/audio/:filename", async (c) => {
        try {
            const id = c.req.param("id");
            const tab = await getTab(id);
            if (!tab.public) {
                await checkLogin(c);
            }

            const filename = c.req.param("filename");
            checkFilename(filename);
            const filePath = path.join(tabDir, id, filename);

            // Check if file exists
            if (!await fs.exists(filePath)) {
                throw new Error("Audio file not found");
            }

            // serve the file
            const stat = await Deno.stat(filePath);
            const size = stat.size;
            const rangeHeader = c.req.header("range");

            // HTML audio/video needs HTTP range support to seek (e.g. jumping
            // the cursor to a highlighted bar), so serve partial content when
            // a Range header is present.
            const encodedFilename = encodeURIComponent(filename);
            let mime = "application/octet-stream";
            let mimeList: Record<string, string> = {
                "mp3": "audio/mpeg",
                "ogg": "audio/ogg",
            };

            const ext = filename.split(".").pop()?.toLowerCase();
            if (ext && mimeList[ext]) {
                mime = mimeList[ext];
            }

            const baseHeaders = {
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Content-Disposition": `attachment; filename="${encodedFilename}"`,
            };

            if (rangeHeader) {
                const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
                if (m) {
                    let start = m[1] ? parseInt(m[1], 10) : 0;
                    let end = m[2] ? parseInt(m[2], 10) : size - 1;
                    if (isNaN(start)) {
                        start = 0;
                    }
                    if (isNaN(end) || end >= size) {
                        end = size - 1;
                    }
                    if (start > end || start >= size) {
                        return c.body(null, 416, { "Content-Range": `bytes */${size}` });
                    }
                    // Read only the requested slice instead of the whole file
                    const file = await Deno.open(filePath, { read: true });
                    const length = end - start + 1;
                    const buf = new Uint8Array(length);
                    await file.seek(start, Deno.SeekMode.Start);
                    const bytesRead = await file.read(buf);
                    file.close();
                    return c.body(bytesRead !== null ? buf.subarray(0, bytesRead) : buf, 206, {
                        ...baseHeaders,
                        "Content-Range": `bytes ${start}-${end}/${size}`,
                        "Content-Length": String(length),
                    });
                }
            }

            // No Range header: serve the whole file
            const file = await Deno.open(filePath, {
                read: true,
            });

            return c.body(file.readable, 200, {
                ...baseHeaders,
                "Content-Length": String(size),
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Add Youtube (/api/tab/${tabID}/youtube)
    app.post("/api/tab/:id/youtube", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");

            const body = await c.req.json();
            const data = YoutubeAddDataSchema.parse(body);

            await checkTabExists(id);
            await addYoutube(id, data.videoID);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Save Youtube config (POST /api/tab/${tabID}/youtube/${videoID})
    app.post("/api/tab/:id/youtube/:videoID", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const videoID = c.req.param("videoID");

            const body = await c.req.json();
            const data = SyncRequestSchema.parse(body);

            await checkTabExists(id);
            await updateYoutube(id, videoID, data);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Remove Youtube (DELETE /api/tab/${tabID}/youtube/${videoID})
    app.delete("/api/tab/:id/youtube/:videoID", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const videoID = c.req.param("videoID");

            await checkTabExists(id);
            await removeYoutube(id, videoID);

            return c.json({
                ok: true,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Serve tab file
    app.get("/api/tab/:id/file", async (c) => {
        try {
            const id = c.req.param("id");

            // Unfortunately AlphaTab does not support cookie auth, we need a short lived temp token to auth via query param
            const tempToken = c.req.query("tempToken");

            // Check kv for temp token
            if (tempToken) {
                const tokenData = await kv.get(["temp_token", tempToken]);
                if (!tokenData.value) {
                    throw new Error("Invalid or expired temp token");
                }

                if (tokenData.value !== id) {
                    throw new Error("Temp token does not match tab ID");
                }

                // Delete the token after use
                await kv.delete(["temp_token", tempToken]);
            } else {
                await checkLogin(c);
            }

            const tab = await getTab(id);
            const filePath = getTabFilePath(tab);

            // Check if file exists
            if (!await fs.exists(filePath)) {
                throw new Error("Tab file not found");
            }

            const stat = await Deno.stat(filePath);
            const ext = path.extname(filePath).slice(1).toLowerCase();
            const isPdf = isPdfExt(ext);
            const encodedOriginalFilename = encodeURIComponent(tab.originalFilename);

            // progs4u: PDFs are served as a real document type so the PDF viewer
            // (or the browser's built-in one) can display them in place. Everything
            // else keeps the original download behaviour.
            // `?inline=1` forces inline for any format; `?disposition=attachment`
            // forces a download for PDFs.
            const wantsInline = c.req.query("inline") === "1" || c.req.query("disposition") === "inline";
            const wantsAttachment = c.req.query("disposition") === "attachment";
            const disposition = wantsAttachment ? "attachment" : (wantsInline || isPdf ? "inline" : "attachment");

            const headers: Record<string, string> = {
                "Content-Type": isPdf ? PDF_MIME : "application/octet-stream",
                "Content-Disposition": `${disposition}; filename="${encodedOriginalFilename}"`,
                "Accept-Ranges": "bytes",
                "Content-Length": stat.size.toString(),
            };

            // Byte ranges: pdf.js and browser PDF viewers fetch large files in
            // chunks instead of downloading them whole.
            const rangeHeader = c.req.header("range");
            if (rangeHeader && isPdf) {
                const range = parseRangeHeader(rangeHeader, stat.size);
                if (!range) {
                    return c.body(null, 416, {
                        "Content-Range": `bytes */${stat.size}`,
                    });
                }

                const file = await Deno.open(filePath, { read: true });
                const length = range.end - range.start + 1;

                return c.body(readRange(file, range.start, length), 206, {
                    ...headers,
                    "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
                    "Content-Length": length.toString(),
                });
            }

            // serve the file
            const file = await Deno.open(filePath, {
                read: true,
            });

            return c.body(file.readable, 200, headers);
        } catch (e) {
            console.error(e);
            return generalError(c, e);
        }
    });

    // Generate temp token for tab file access
    app.get("/api/tab/:id/temp-token", async (c) => {
        try {
            const id = c.req.param("id");

            const tab = await getTab(id);

            if (!tab.public) {
                await checkLogin(c);
            }

            const token = crypto.randomUUID();

            // expireIn 20 seconds

            await kv.set(["temp_token", token], tab.id, { expireIn: 20 * 1000 });
            return c.json({
                ok: true,
                token,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    app.get("/api/settings", async (c) => {
        try {
            const session = await getCurrentSession(c);
            const entry = await kv.get(["user_setting", session.user.id]);
            const setting = entry.value;
            if (!setting) {
                throw new Error("Settings not found on server");
            }
            return c.json({
                ok: true,
                setting,
            });
        } catch (e) {
            return generalError(c, e);
        }
    });

    app.post("/api/settings", async (c) => {
        try {
            const session = await getCurrentSession(c);
            const body = await c.req.json();
            await kv.set(["user_setting", session.user.id], body);
            return c.json({ ok: true });
        } catch (e) {
            return generalError(c, e);
        }
    });

    // Open folder and Open external (Windows only)
    app.post("/api/tab/:id/open-folder", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const tab = await getTab(id);

            if (!Deno.build.standalone || Deno.build.os !== "windows") {
                throw new Error("Open folder is only supported on Windows");
            }
            const folder = getTabFolderPath(tab);
            const child = new Deno.Command("explorer.exe", {
                args: [folder],
                stdout: "null",
                stderr: "null",
            }).spawn();
            await child.status;
            return c.json({ ok: true });
        } catch (e) {
            return generalError(c, e);
        }
    });

    app.post("/api/tab/:id/open-external", async (c) => {
        try {
            await checkLogin(c);
            const id = c.req.param("id");
            const tab = await getTab(id);

            if (!Deno.build.standalone || Deno.build.os !== "windows") {
                throw new Error("Open external is only supported on Windows");
            }

            const fullPath = getTabFullFilePath(tab);
            const child = new Deno.Command("cmd", {
                args: ["/c", "start", "", fullPath],
                stdout: "null",
                stderr: "null",
            }).spawn();
            await child.status;
            return c.json({ ok: true });
        } catch (e) {
            return generalError(c, e);
        }
    });

    app.get("/", (c) => {
        return c.html(indexHTML);
    });

    // Serve static files
    // @ts-ignore No idea why ts is complaining here
    app.get(
        "*",
        serveStatic({
            root: path.join(frontendDir),
        }),
    );

    // if /api/* not found, return 404
    app.all("/api/*", (c) => {
        return c.json({
            ok: false,
            msg: "Page Not found",
        }, 404);
    });

    // For SPA, always return index.html
    app.notFound((c) => {
        return c.html(indexHTML, 200);
    });

    const signalHandler = () => {
        closeServer();
        Deno.exit();
    };

    // Close Server event
    Deno.addSignalListener("SIGINT", signalHandler);

    if (Deno.build.os === "linux") {
        Deno.addSignalListener("SIGTERM", signalHandler);
    }

    // Unhandled Rejection
    globalThis.addEventListener("unhandledrejection", (e) => {
        console.log("unhandled rejection at:", e.promise, "reason:", e.reason);
        e.preventDefault();
    });
}

export function closeServer() {
    if (httpServer) {
        httpServer.close();
    }
    kv.close();
    db.close();
    console.log("Server closed");
}

function generalError(c: Context, e: unknown) {
    if (e instanceof ZodError) {
        let message = "";
        for (const issue of e.issues) {
            message += `${issue.path.join(".")}: ${issue.message}\n`;
        }
        return c.json({
            ok: false,
            msg: message,
        }, 400);
    } else if (e instanceof Error) {
        return c.json({
            ok: false,
            msg: e.message,
        }, 400);
    } else {
        return c.json({
            ok: false,
            msg: "Unknown error",
        }, 400);
    }
}

if (import.meta.main) {
    await main();
}
