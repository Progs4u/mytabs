/**
 * progs4u fork: turn a downloaded file name (and its folder) into tab metadata.
 *
 * The libraries this is built for are not tidy: no folder tree, files named after the pack
 * they came in ("60. Bach Style Voicings.pdf"), loose qualifiers for different qualities of
 * the same piece ("(scan)", "[chords]", "v2"), and download-site noise
 * ("www.guitartabs.cc-Sultans of Swing.pdf").
 *
 * Everything here is a pure function and lives in the shared module so the importer, the
 * upload path and (later) the UI's rename preview all agree on what a file name means.
 */

/** Canonical tags extracted from a file name. Free-form tags are allowed too (`source:…`). */
export const QUALIFIER_TAGS: Record<string, string> = {
    // what kind of document it is
    "scan": "scan",
    "scanned": "scan",
    "handwritten": "handwritten",
    "chords": "chords",
    "chord": "chords",
    "chord chart": "chords",
    "tab": "tab",
    "tabs": "tab",
    "tablature": "tab",
    "sheet": "sheet",
    "sheet music": "sheet",
    "score": "sheet",
    "official": "official",
    "book": "book",
    "fakebook": "book",
    "real book": "book",
    // instrument / role
    "bass": "bass",
    "guitar": "guitar",
    "lead": "lead",
    "rhythm": "rhythm",
    "solo": "solo",
    "fingerstyle": "fingerstyle",
    "fingerpicking": "fingerstyle",
    "classical": "classical",
    "drums": "drums",
    "piano": "piano",
    "vocals": "vocals",
    // state
    "draft": "draft",
    "clean": "clean",
    "live": "live",
    "studio": "studio",
    "instrumental": "instrumental",
    "easy": "easy",
    "advanced": "advanced",
    "simplified": "simplified",
};

/** Sites that stamp themselves onto the file name; captured as `source:*` tags. */
const SOURCE_PATTERNS: [RegExp, string][] = [
    [/^\s*www\.([a-z0-9-]+\.[a-z.]{2,})[-_ ]/i, "source:$1"],
    [/\bwww\.([a-z0-9-]+\.[a-z.]{2,})\b/i, "source:$1"],
    [/\b([a-z0-9-]+\.(?:com|net|org|cc|ru|de|hu|pl))\b/i, "source:$1"],
];

export interface ParsedTabName {
    /** Piece title, with pack numbers, site stamps and qualifiers removed. */
    title: string;
    /** Artist/composer, empty when nothing in the name can be trusted as one. */
    artist: string;
    /** Pack sequence number when the name starts with one ("60. …", "003 …"). */
    sequence: number | null;
    /** Canonical qualifier tags found in the name. */
    tags: string[];
    /** Collection derived from the folder the file was found in ("" when there is none). */
    collection: string;
    /** True when artist/title were split on a " - " but the order looked unusual. */
    uncertainOrder: boolean;
}

/**
 * Parse a file name (and optional folder path) into tab metadata.
 * Never throws and never returns empty values: a name that yields nothing usable stays the
 * title, so nothing is ever lost silently.
 */
export function parseTabFilename(filename: string, folder = ""): ParsedTabName {
    const original = filename;
    const tags: string[] = [];

    // Underscores separate the parts of these file names, so normalise them first: tag
    // matching relies on word boundaries and "_" is a word character.
    let name = filename.replace(/\.[a-z0-9]{1,6}$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();

    // --- source stamps ("www.guitartabs.cc-", "guitartabs.cc")
    for (const [pattern, tagTemplate] of SOURCE_PATTERNS) {
        const match = name.match(pattern);
        if (match) {
            tags.push(tagTemplate.replace("$1", (match[1] ?? "").toLowerCase()));
            name = name.replace(match[0], " ").replace(/\s+/g, " ").trim();
        }
    }

    // --- pack sequence: "60. ", "62 - ", "003 " (leading zeros are a strong pack signal).
    // A bare "3 Something" is a title, not a pack number, so whitespace alone only counts
    // when the number is zero-padded.
    let sequence: number | null = null;
    const seqMatch = name.match(/^(0*\d{1,4})(\s*[.)\]:-]\s*|\s+)/);
    if (seqMatch) {
        const raw = seqMatch[1];
        const separator = seqMatch[2];
        const rest = name.slice(seqMatch[0].length).trim();
        const hasPunctuation = /[.)\]:-]/.test(separator);
        const isPadded = /^0\d/.test(raw);

        if (rest.length > 0 && (hasPunctuation || isPadded)) {
            sequence = parseInt(raw, 10);
            name = rest;
        }
    }

    // --- qualifiers in (), [], {} — split on any separator inside the brackets
    name = name.replace(/[([{]([^)\]}]+)[)\]}]/g, (_all, inner: string) => {
        let matchedAny = false;

        for (const part of inner.split(/[,/&]+|\band\b|\s+/)) {
            const cleaned = part.trim().toLowerCase().replace(/\s+/g, " ");
            if (cleaned === "") {
                continue;
            }
            const mapped = QUALIFIER_TAGS[cleaned];
            if (mapped) {
                tags.push(mapped);
                matchedAny = true;
            } else if (/^v(?:er)?\.?\s?\d+$/.test(cleaned) || /^version\s?\d+$/.test(cleaned)) {
                tags.push("version:" + cleaned.replace(/[^0-9]/g, ""));
                matchedAny = true;
            }
        }

        if (!matchedAny && inner.trim().length > 0 && inner.trim().length <= 24) {
            tags.push("note:" + inner.trim().toLowerCase());
        }

        return " ";
    });

    // --- bare version markers and qualifiers ("... scan v3", "... bass tab")
    name = name.replace(/\bv(?:er)?\.?\s?(\d+)\b/gi, (_all, version: string) => {
        tags.push("version:" + version);
        return " ";
    });

    for (const word of Object.keys(QUALIFIER_TAGS)) {
        const pattern = new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "gi");
        if (pattern.test(name)) {
            const without = name.replace(pattern, " ").replace(/\s+/g, " ").trim();
            // keep a qualifier in the name when removing it would leave almost nothing
            if (without.length >= 3) {
                tags.push(QUALIFIER_TAGS[word]);
                name = without;
            }
        }
    }

    name = name.replace(/\s+/g, " ").replace(/^[\s\-.]+|[\s\-.]+$/g, "").trim();

    // --- artist / title split on " - " / " – " / " — "
    let artist = "";
    let title = name;
    let uncertainOrder = false;

    const parts = name.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
        const left = parts[0].trim();
        const right = parts.slice(1).join(" - ").trim();

        // "Artist - Title" is the common order, but libraries downloaded per creator mix in
        // "title - artist". Two signals: a lowercase title against a capitalised name, or
        // both lowercase with the left side carrying more words ("wish you were here").
        const wordsLeft = left.split(/\s+/).length;
        const wordsRight = right.split(/\s+/).length;
        const leftLooksTitle = (/^[a-z]/.test(left) && /^[A-Z]/.test(right)) ||
            (/^[a-z]/.test(left) && /^[a-z]/.test(right) && wordsLeft > wordsRight);

        if (leftLooksTitle) {
            artist = right;
            title = left;
            uncertainOrder = true;
        } else {
            artist = left;
            title = right;
        }
    }

    if (title.trim() === "") {
        title = original.replace(/\.[a-z0-9]{1,6}$/i, "").trim();
    }

    return {
        title: title.trim(),
        artist: artist.trim(),
        sequence,
        tags: [...new Set(tags)],
        collection: folderCollection(folder),
        uncertainOrder,
    };
}

/**
 * The collection a tab belongs to: the first path segment below the import root.
 * With a flat drop ("all files in one folder") this is empty and collections are curated
 * in the app instead — the report says which files would land in which collection.
 */
export function folderCollection(folder: string): string {
    const parts = folder.split(/[\\/]+/).filter((part) => part !== "" && part !== "." && part !== "..");
    if (parts.length === 0) {
        return "";
    }
    return parts[0].trim();
}

/** Grouping key for "same piece, different quality" detection. */
export function workKey(parsed: { title: string; artist: string }): string {
    const normalize = (value: string) =>
        value
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9 ]/g, " ")
            .replace(/\b(the|a|an|and|of|in|for)\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    return `${normalize(parsed.artist)}|${normalize(parsed.title)}`;
}

/**
 * Titles in download manifests ("video_title" in classclef's links.tsv, and similar exports)
 * are far richer than file names, but padded with site noise:
 *
 *   "TAB/Sheet: Ghiribizzo No 36 by Niccolo Paganini | Detailed Guitar Tab, ... Tutorial"
 *   "TAB/Sheet: Oblivion (Arranged by Roland Dyens) by Astor Piazzolla [PDF + Guitar Pro + MIDI]"
 *   "TAB/Sheet: Bach's BWV 1005 Fugue [PDF + Guitar Pro + MIDI]"
 *
 * This extracts the piece title, the composer and the arranger from that shape.
 */
export interface ParsedManifestTitle {
    title: string;
    artist: string;
    arranger: string;
    /** The raw title, kept so nothing is lost if the parse is wrong. */
    sourceTitle: string;
    /** True when the composer had to be guessed (possessive form, file name). */
    artistGuessed: boolean;
}

const NOISE_PATTERNS: RegExp[] = [
    /^\s*TAB\/Sheet\s*:?\s*/i,
    /^\s*Sheet\s*\/\s*Tab\s*:?\s*/i,
    /\s*[|\uFF5C]\s*(?:Detailed\s+)?Guitar\s+Tab.*$/i,
    /\s*\[(?:PDF|MIDI)[^\]]*\]\s*$/i,
    /\s*\((?:PDF|MIDI)[^)]*\)\s*$/i,
    /\s*(?:PDF|MIDI|Guitar\s+Pro)(?:\s*\+\s*(?:PDF|MIDI|Guitar\s+Pro))+\s*$/i,
    /\s*Midi\s*$/i,
];

/** "(Arranged by X)", "Arranged by X", "(Arr. X)", "arr: X" */
const ARRANGER_PATTERNS: RegExp[] = [
    /\(\s*(?:arranged|arr\.?)\b\s*(?:by)?\s*:?\s*([^)]+?)\s*\)/i,
    /\s*[\[(]?\s*(?:arranged|arr\.?)\b\s+by\s*:?\s*([^|\[\]]+?)\s*(?=[\[|]|$)/i,
    /\s*[\[(]?\s*arr\s*:\s*([^|\[\]]+?)\s*(?=[\[|]|$)/i,
];

export function parseManifestTitle(
    rawTitle: string,
    fallbackFilename = "",
    knownComposers: Map<string, string> = new Map(),
): ParsedManifestTitle {
    const sourceTitle = rawTitle;
    let text = ` ${rawTitle} `.replace(/\s+/g, " ");

    for (const pattern of NOISE_PATTERNS) {
        text = text.replace(pattern, " ");
    }
    text = text.replace(/\s+/g, " ").trim();

    // arranger first: "Arranged by X" contains " by " and would otherwise read as composer
    let arranger = "";
    for (const pattern of ARRANGER_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            arranger = match[1].replace(/\s+/g, " ").trim();
            text = text.replace(match[0], " ").replace(/\s+/g, " ").trim();
            break;
        }
    }

    // composer: the LAST " by " credit (titles exist like "Book 5 Lesson 14 by Julio
    // Sagreras by Julio Sagreras", where the site repeated the credit)
    let artist = "";
    let artistGuessed = false;

    const parts = text.split(/\s+by\s+/i);
    if (parts.length >= 2) {
        artist = parts[parts.length - 1].replace(/\s+/g, " ").trim();
        text = parts.slice(0, -1).join(" by ").trim();

        // drop a duplicated trailing credit left in the title
        const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`\\s+by\\s+${escaped}\\s*$`, "i"), "").trim();
    }

    // possessive form: "Bach's BWV 1005 Fugue"
    if (artist === "") {
        const poss = text.match(/^([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,2})['’]s\s+(.+)$/);
        if (poss) {
            artist = poss[1];
            text = poss[2];
            artistGuessed = true;
        }
    }

    // Last resort: a composer-first file name ("bach-bwv401.pdf"). Only accepted when the
    // slug matches a composer that appears elsewhere in the same library - otherwise
    // "ojos-negros.pdf" would invent a composer named "Ojos".
    if (artist === "" && fallbackFilename !== "") {
        const slug = fallbackFilename.replace(/\.[a-z0-9]{1,6}$/i, "");
        const slugMatch = slug.match(/^([a-z]{3,})-/);
        if (slugMatch) {
            const known = knownComposers.get(slugMatch[1].toLowerCase());
            if (known) {
                artist = known;
                artistGuessed = true;
            }
        }
    }

    let title = text.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "").replace(/\s+/g, " ").trim();
    if (title === "") {
        title = fallbackFilename.replace(/\.[a-z0-9]{1,6}$/i, "").trim() || sourceTitle;
    }

    return { title, artist, arranger, sourceTitle, artistGuessed };
}

/**
 * A library downloads the same composer under many spellings ("Johann Sebastian Bach",
 * "J.S Bach", "Bach"), which splits one person across several entries. These are merged so
 * grouping and search see one composer. Add to this list as real data shows up rather than
 * guessing: only names seen in the wild belong here.
 */
export const COMPOSER_ALIASES: Record<string, string> = {
    "j s bach": "Johann Sebastian Bach",
    "js bach": "Johann Sebastian Bach",
    "johann sebastian bach": "Johann Sebastian Bach",
    "johann sebastain bach": "Johann Sebastian Bach",
    "bach": "Johann Sebastian Bach",
    "agustin barrios": "Agustin Barrios Mangore",
    "augustin barrios": "Agustin Barrios Mangore",
    "agustin barrios mangore": "Agustin Barrios Mangore",
    "augustin barrios mangore": "Agustin Barrios Mangore",
    "barrios": "Agustin Barrios Mangore",
    "silvius leopold weiss": "Silvius Leopold Weiss",
    "silvius leoplod weiss": "Silvius Leopold Weiss",
    "weiss": "Silvius Leopold Weiss",
    "niccolo paganini": "Niccolo Paganini",
    "nicolo paganini": "Niccolo Paganini",
    "paganini": "Niccolo Paganini",
    "francisco tarrega": "Francisco Tarrega",
    "tarrega": "Francisco Tarrega",
    "heitor villa lobos": "Heitor Villa-Lobos",
    "heitor villa-lobos": "Heitor Villa-Lobos",
    "villa lobos": "Heitor Villa-Lobos",
    "isaac albeniz": "Isaac Albeniz",
    "manuel ponce": "Manuel Ponce",
    "manuel maria ponce": "Manuel Ponce",
    "manuel marial ponce": "Manuel Ponce",
};

/** Merge the spellings of one composer into a single canonical name. */
export function canonicalComposer(name: string): string {
    const cleaned = name.replace(/\s+/g, " ").replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
    if (cleaned === "") {
        return "";
    }
    const key = cleaned
        .toLowerCase()
        .replace(/[.]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^(johann|j)\s/, (m) => m) // keep leading initials usable as keys
        .trim();
    return COMPOSER_ALIASES[key] ?? cleaned;
}

/**
 * Anonymous material (folksongs, "Traditional") has no composer credit to find. Saying so is
 * more honest than leaving the field empty or inventing a name.
 */
export function isTraditionalTitle(title: string): boolean {
    return /\b(traditional|folksong|folk song|anon\.?|anonymous)\b/i.test(title);
}
