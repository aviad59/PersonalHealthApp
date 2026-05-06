// Client-side image compression.
//
// Why: A modern phone photo is 3–6 MB JPEG (or HEIC). When we save a meal
// we send that photo to /api/meals/analyze AND store it as a base64 data
// URI in the DB. Multi-MB body uploads push the request well past 1s on
// mobile networks and bloat the DB row. Resizing to ~1280px on the long
// edge and recompressing as JPEG q=0.78 typically lands the file at
// 150–350 KB — usually 10–25× smaller — with no visible change for the
// thumbnail-and-detail uses we have.

export type CompressedImage = {
  base64: string;       // raw base64, no data: prefix
  dataUri: string;      // full data:image/jpeg;base64,... for previews
  ext: "jpg";           // we always emit JPEG for predictable sizing
  bytes: number;        // approximate decoded byte count
};

const MAX_DIM = 1280;
const QUALITY = 0.78;
// Thumbnails: 160 px is plenty for the 48–56 px display targets even on
// 3× DPI screens, and JPEG q=0.55 yields ~5–10 KB. That's small enough to
// inline directly as a data URI in SSR HTML without bloating page weight.
const THUMB_DIM = 160;
const THUMB_QUALITY = 0.55;

export async function compressImageFile(file: File): Promise<CompressedImage> {
  return reencode(file, MAX_DIM, QUALITY);
}

/** Tiny thumbnail variant intended to be inlined as a data URI. */
export async function compressImageThumb(file: File): Promise<CompressedImage> {
  return reencode(file, THUMB_DIM, THUMB_QUALITY);
}

async function reencode(
  file: File,
  maxDim: number,
  quality: number,
): Promise<CompressedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { canvas, w, h } = drawScaled(img, maxDim);

    // toDataURL("image/jpeg", quality) re-encodes whatever pixels we drew.
    // The canvas backdrop is transparent by default, so we paint white
    // first so PNG-with-alpha photos don't come out with black backgrounds.
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext("2d")!;
      tctx.fillStyle = "#ffffff";
      tctx.fillRect(0, 0, w, h);
      tctx.drawImage(canvas, 0, 0);
      return finalize(tmp.toDataURL("image/jpeg", quality));
    }
    return finalize(canvas.toDataURL("image/jpeg", quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = src;
  });
}

function drawScaled(
  img: HTMLImageElement,
  maxDim: number,
): { canvas: HTMLCanvasElement; w: number; h: number } {
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, w, h };
}

function finalize(dataUri: string): CompressedImage {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!m) {
    throw new Error("Compression produced an unexpected data URI");
  }
  const base64 = m[2];
  // Approximate decoded byte count: every 4 base64 chars decode to 3 bytes,
  // minus padding. Useful for rough log/debug.
  const bytes = Math.floor((base64.length * 3) / 4);
  return {
    base64,
    dataUri,
    ext: "jpg",
    bytes,
  };
}
