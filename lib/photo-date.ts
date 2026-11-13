// When was this photo taken?
//
// Backfilling from the camera roll days later means the page's date picker is
// the wrong source for a meal's date — the photo already knows. We read the
// EXIF DateTimeOriginal straight from the ORIGINAL file (canvas compression
// strips EXIF, so this must run before compressImageFile), falling back to
// File.lastModified, which Android sets to the capture time.

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

// The EXIF APP1 segment sits at the start of the file and is capped at 64 KB.
const HEAD_BYTES = 128 * 1024;

/** Capture time in epoch ms, or null if the file carries none. */
export async function photoTakenAt(file: File): Promise<number | null> {
  try {
    const buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const exif = readExifDate(new DataView(buf));
    if (exif !== null) return exif;
  } catch {
    // unreadable / not a JPEG — fall through
  }
  return file.lastModified || null;
}

/** Parse "YYYY:MM:DD HH:MM:SS" out of a JPEG's EXIF block, as device-local time. */
export function readExifDate(v: DataView): number | null {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    if (v.getUint8(off) !== 0xff) return null;
    const marker = v.getUint8(off + 1);
    const size = v.getUint16(off + 2);
    // Start of scan — image data follows, no more metadata.
    if (marker === 0xda) return null;
    if (marker === 0xe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966 /* "Exif" */) {
      return readTiff(v, off + 10);
    }
    off += 2 + size;
  }
  return null;
}

function readTiff(v: DataView, tiff: number): number | null {
  if (tiff + 8 > v.byteLength) return null;
  const le = v.getUint16(tiff) === 0x4949; // "II"
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);

  const ifd0 = readIfd(v, tiff, tiff + u32(tiff + 4), u16, u32);
  if (!ifd0) return null;
  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  const exif = exifPtr !== undefined ? readIfd(v, tiff, tiff + exifPtr, u16, u32) : null;

  for (const [ifd, tag] of [
    [exif, TAG_DATETIME_ORIGINAL],
    [exif, TAG_DATETIME_DIGITIZED],
    [ifd0, TAG_DATETIME],
  ] as const) {
    const ptr = ifd?.get(tag);
    if (ptr === undefined) continue;
    const ts = parseExifDateString(v, tiff + ptr);
    if (ts !== null) return ts;
  }
  return null;
}

/** Map of tag -> value/offset field for one IFD. */
function readIfd(
  v: DataView,
  tiff: number,
  at: number,
  u16: (o: number) => number,
  u32: (o: number) => number,
): Map<number, number> | null {
  if (at + 2 > v.byteLength) return null;
  const count = u16(at);
  const out = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    out.set(u16(e), u32(e + 8));
  }
  return out;
}

function parseExifDateString(v: DataView, at: number): number | null {
  if (at + 19 > v.byteLength) return null;
  let s = "";
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(at + i));
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  if (y < 2000) return null; // "0000:00:00 00:00:00" placeholders
  return new Date(y, mo - 1, d, h, mi, sec).getTime();
}

/** Device-local YYYY-MM-DD for an epoch ms. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
