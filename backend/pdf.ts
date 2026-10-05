/**
 * progs4u fork: server-side helpers for PDF tabs.
 *
 * PDFs are stored exactly like any other tab file (data/<id>/tab.pdf) but they are
 * served inline as `application/pdf` with byte-range support, because the PDF
 * viewer (pdf.js) and the browser's built-in viewer both request ranges instead of
 * downloading the whole file.
 */

export const PDF_MIME = "application/pdf";

/**
 * Parse a single-range `Range: bytes=x-y` header.
 * Returns null when the range is invalid/unsatisfiable (-> 416).
 */
export function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || size === 0) {
        return null;
    }

    const [, rawStart, rawEnd] = match;

    let start: number;
    let end: number;

    if (rawStart === "") {
        if (rawEnd === "") {
            return null;
        }
        // Suffix range: the last N bytes.
        const suffixLength = parseInt(rawEnd, 10);
        if (isNaN(suffixLength) || suffixLength <= 0) {
            return null;
        }
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = parseInt(rawStart, 10);
        end = rawEnd === "" ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
    }

    if (isNaN(start) || isNaN(end) || start > end || start >= size || start < 0) {
        return null;
    }

    return { start, end };
}

/**
 * Stream `length` bytes of an already-open file, starting at `start`.
 * The file is closed when the stream ends or the client disconnects.
 */
export function readRange(file: Deno.FsFile, start: number, length: number): ReadableStream<Uint8Array> {
    return ReadableStream.from((async function* () {
        const CHUNK_SIZE = 256 * 1024;
        try {
            file.seekSync(start, Deno.SeekMode.Start);
            let remaining = length;
            while (remaining > 0) {
                const chunk = new Uint8Array(Math.min(remaining, CHUNK_SIZE));
                const read = await file.read(chunk);
                if (read === null || read === 0) {
                    break;
                }
                remaining -= read;
                yield chunk.subarray(0, read);
            }
        } finally {
            try {
                file.close();
            } catch {
                // already closed
            }
        }
    })());
}
