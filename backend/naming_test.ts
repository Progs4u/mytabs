// "deno task test" to run this test
//
// progs4u fork: naming rules for imported libraries. These cases come from the shapes real
// downloads arrive in (numbered packs, loose qualifiers for different qualities of the same
// piece, download-site stamps) - see backend/naming.ts.

import { assertEquals } from "jsr:@std/assert@^1.0.17";

const { parseTabFilename, workKey, folderCollection } = await import("./naming.ts");

Deno.test("naming - numbered pack file without an artist", () => {
    const parsed = parseTabFilename("60. Bach Style Voicings.pdf");
    assertEquals(parsed.sequence, 60);
    assertEquals(parsed.title, "Bach Style Voicings");
    assertEquals(parsed.artist, "");
    assertEquals(parsed.tags, []);
});

Deno.test("naming - numbered pack file with artist and title", () => {
    const parsed = parseTabFilename("62 - Bach - Air on the G String.pdf");
    assertEquals(parsed.sequence, 62);
    assertEquals(parsed.artist, "Bach");
    assertEquals(parsed.title, "Air on the G String");
});

Deno.test("naming - zero-padded sequence is a pack number even without punctuation", () => {
    const parsed = parseTabFilename("003 Metallica - Nothing Else Matters (scan).pdf");
    assertEquals(parsed.sequence, 3);
    assertEquals(parsed.artist, "Metallica");
    assertEquals(parsed.title, "Nothing Else Matters");
    assertEquals(parsed.tags, ["scan"]);
});

Deno.test("naming - a title that starts with a number is not a pack number", () => {
    const parsed = parseTabFilename("3 Little Birds.pdf");
    assertEquals(parsed.sequence, null);
    assertEquals(parsed.title, "3 Little Birds");
});

Deno.test("naming - bracketed and bare qualifiers become tags", () => {
    assertEquals(parseTabFilename("Metallica - Master of Puppets [chords].pdf").tags, ["chords"]);
    assertEquals(parseTabFilename("12. Joe Pass - Autumn Leaves (bass tab).pdf").tags.sort(), ["bass", "tab"]);
    assertEquals(parseTabFilename("Bach_Style_Voicings_scan_v3.pdf").tags.sort(), ["scan", "version:3"]);
    assertEquals(parseTabFilename("ACDC - Back in Black (v2).pdf").tags, ["version:2"]);
});

Deno.test("naming - underscores are separators", () => {
    const parsed = parseTabFilename("Bach_Style_Voicings_scan_v3.pdf");
    assertEquals(parsed.title, "Bach Style Voicings");
});

Deno.test("naming - download-site stamps become source tags and leave the title", () => {
    const parsed = parseTabFilename("www.guitartabs.cc-Sultans of Swing.pdf");
    assertEquals(parsed.title, "Sultans of Swing");
    assertEquals(parsed.tags, ["source:guitartabs.cc"]);
});

Deno.test("naming - 'Title - Artist' order is detected and swapped", () => {
    const parsed = parseTabFilename("wish you were here - pink floyd (fingerstyle).pdf");
    assertEquals(parsed.artist, "pink floyd");
    assertEquals(parsed.title, "wish you were here");
    assertEquals(parsed.tags, ["fingerstyle"]);
    assertEquals(parsed.uncertainOrder, true);

    const normal = parseTabFilename("Chet Atkins - Windy and Warm.pdf");
    assertEquals(normal.artist, "Chet Atkins");
    assertEquals(normal.title, "Windy and Warm");
    assertEquals(normal.uncertainOrder, false);
});

Deno.test("naming - a bare title is left as the title, never empty", () => {
    const parsed = parseTabFilename("greensleeves.pdf");
    assertEquals(parsed.title, "greensleeves");
    assertEquals(parsed.artist, "");
    assertEquals(parsed.sequence, null);
});

Deno.test("naming - the folder becomes the collection", () => {
    assertEquals(parseTabFilename("x.pdf", "Bach/Suites").collection, "Bach");
    assertEquals(folderCollection("Metallica"), "Metallica");
    assertEquals(folderCollection(""), "");
    assertEquals(folderCollection("."), "");
});

Deno.test("naming - work key groups the same piece across qualities", () => {
    const a = parseTabFilename("60. Bach Style Voicings.pdf");
    const b = parseTabFilename("Bach_Style_Voicings_scan_v3.pdf");
    const c = parseTabFilename("Metallica - Nothing Else Matters (scan).pdf");

    assertEquals(workKey(a), workKey(b));
    assertEquals(workKey(a) !== workKey(c), true);
});
