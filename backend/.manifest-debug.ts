const { parseManifestTitle } = await import("./naming.ts");
const cases: [string, string][] = [
    ["TAB/Sheet: Ghiribizzo No 36 by Niccolo Paganini | Detailed Guitar Tab, Sheet Music, & MIDI Tutorial", "paganini-ghiribizzo36.pdf"],
    ["TAB/Sheet: Oblivion (Arranged by Roland Dyens) by Astor Piazzolla [PDF + Guitar Pro + MIDI]", "piazzolla-dyens-oblivion.pdf"],
    ["TAB/Sheet: Bach's BWV 1005 Fugue [PDF + Guitar Pro + MIDI]", "bach-bwv1005-fuga.pdf"],
    ["TAB/Sheet: Bach's BWV 1005 Fugue [PDF + Guitar Pro + MIDI]", "bwv-1005-allegro-assai-jsbach.pdf"],
    ["Book 5 Lesson 14 by Julio Sagreras by Julio Sagreras [PDF + Guitar Pro + MIDI]", "sagreras-book5-14.pdf"],
    ["TAB/Sheet: Johnny Guitar (Peggy Lee/Victor Young) Arranged by Isaias Savio | Guitar Tab, Sheet Music & MIDI", "savio-johnny-guitar.pdf"],
    ["BWV 819 I Allemande by Johann Sebastian Bach [PDF + Guitar Pro + MIDI]", "bach-bwv819-allemande.pdf"],
    ["TAB/Sheet: Prelude No. 13 (Segovia No. 3) by Manuel Ponce [PDF + Guitar Pro + MIDI]", "ponce-prelude13.pdf"],
    ["Minueto en Si | Detailed Guitar Tab, Sheet Music, & MIDI Tutorial", "barrios-minuet-b.pdf"],
    ["TAB/Sheet: Dark Eyes (Ojos Negros) Russian Folksong [PDF + Guitar Pro + MIDI]", "ojos-negros.pdf"],
];
for (const [raw, file] of cases) {
    const p = parseManifestTitle(raw, file);
    console.log(`  ${file}\n     title=${JSON.stringify(p.title)}\n     artist=${JSON.stringify(p.artist)}${p.artistGuessed ? " (guessed)" : ""} arranger=${JSON.stringify(p.arranger)}\n`);
}
