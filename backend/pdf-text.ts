/**
 * progs4u fork: reading what is printed inside a PDF.
 *
 * Sheet music PDFs from these libraries are born-digital, so the title, composer, tempo
 * marks and (for text-based scores) the notes themselves are real text inside the file.
 * Extracting it serves two purposes: it makes the content searchable, and it settles
 * questions the file name and the download manifest disagree about.
 *
 * Requires poppler-utils (pdftotext, pdfinfo) in the image.
 */

const decoder = new TextDecoder();

/** Text of the first `pages` pages, or "" when the file has no text layer (a scan). */
export async function extractPdfText(file: string, pages = 3): Promise<string> {
    try {
        const command = new Deno.Command("pdftotext", {
            args: ["-f", "1", "-l", String(pages), "-layout", file, "-"],
            stdout: "piped",
            stderr: "null",
        });
        const { stdout } = await command.output();
        return decoder.decode(stdout);
    } catch (e) {
        console.warn(`pdftotext failed for ${file}: ${(e as Error).message}`);
        return "";
    }
}

/** Page count via pdfinfo; 0 when it cannot be read. */
export async function pdfPageCount(file: string): Promise<number> {
    try {
        const command = new Deno.Command("pdfinfo", { args: [file], stdout: "piped", stderr: "null" });
        const { stdout } = await command.output();
        const match = decoder.decode(stdout).match(/^Pages:\s+(\d+)/m);
        return match ? parseInt(match[1], 10) : 0;
    } catch {
        return 0;
    }
}

export interface PdfProbe {
    text: string;
    pageCount: number;
    /** A file with no extractable text is a scan and would need OCR. */
    hasText: boolean;
}

export async function probePdf(file: string, pages = 3): Promise<PdfProbe> {
    const [text, pageCount] = await Promise.all([extractPdfText(file, pages), pdfPageCount(file)]);
    return { text, pageCount, hasText: text.trim().length >= 40 };
}

/**
 * How well a candidate title matches the words printed on the page (0..1). Used to choose
 * between contradictory manifest rows: the page itself is the tie-breaker.
 */
export function scoreTitleAgainstText(candidate: string, printedText: string): number {
    const pageWords = new Set(
        printedText
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9 ]/g, " ")
            .split(/\s+/)
            .filter((word) => word.length >= 3),
    );
    if (pageWords.size === 0) {
        return 0;
    }

    const tokens = candidate
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !["the", "and", "for", "with", "tab", "sheet"].includes(word));

    if (tokens.length === 0) {
        return 0;
    }
    return tokens.filter((token) => pageWords.has(token)).length / tokens.length;
}
