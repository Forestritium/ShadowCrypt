/**
 * Validates file magic bytes to detect disguised executables.
 * Returns true if the file appears to be an executable/script, false otherwise.
 */
export async function isExecutableMagicBytes(file: File): Promise<boolean> {
  // Read first 8 bytes
  const slice = file.slice(0, 8);
  const buffer = await slice.arrayBuffer();
  const view = new Uint8Array(buffer);
  
  if (view.length < 2) return false; // Too small to be an executable

  // Check MZ (Windows PE/EXE/DLL/SYS)
  if (view[0] === 0x4D && view[1] === 0x5A) return true;

  // Check ELF (Linux binaries, .so, etc.)
  if (view.length >= 4 && view[0] === 0x7F && view[1] === 0x45 && view[2] === 0x4C && view[3] === 0x46) return true;

  // Check Mach-O (macOS)
  // 32-bit: CE FA ED FE or CF FA ED FE
  // 64-bit: CF FA ED FE
  // FAT: CA FE BA BE
  if (view.length >= 4) {
    const magic32 = view[0] === 0xCE && view[1] === 0xFA && view[2] === 0xED && view[3] === 0xFE;
    const magic64 = view[0] === 0xCF && view[1] === 0xFA && view[2] === 0xED && view[3] === 0xFE;
    const magicFat = view[0] === 0xCA && view[1] === 0xFE && view[2] === 0xBA && view[3] === 0xBE;
    if (magic32 || magic64 || magicFat) return true;
  }

  // Check Shebang (Shell scripts: #!)
  if (view[0] === 0x23 && view[1] === 0x21) return true;

  // Check ZIP-based files that might be Java JARs, APKs, IPAs, etc.
  // ZIP: 50 4B 03 04. We don't block ALL zips, but if we strictly want to block JARs we might.
  // For now, we rely on extensions for ZIP-based formats because DOCX/XLSX are also ZIPs.
  // The magic bytes check is a second layer primarily for native binaries & scripts disguised as .txt/.png.

  return false;
}
