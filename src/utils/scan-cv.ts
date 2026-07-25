// Page-edge detection for the scanner (slice 2).
//
// OpenCV.js is ~8 MB, so it is loaded LAZILY from a CDN and only when someone
// actually opens the scanner — it never costs anything for other users. Every
// entry point here degrades to null/identity rather than throwing: if the CDN is
// unreachable (a parent on poor mobile data) the scan must still work, just
// without auto-cropping.

export type Corner = { x: number; y: number };
export type Quad = [Corner, Corner, Corner, Corner]; // top-left, top-right, bottom-right, bottom-left

// An npm-backed CDN with an immutable version, NOT docs.opencv.org: the docs site
// has no stable per-version file (the obvious /4.10.0/opencv.js path 404s, which
// silently disabled cropping for everyone until a load test caught it).
const CV_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
const READY_TIMEOUT_MS = 45_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CV = any;
let cvPromise: Promise<CV | null> | null = null;

/** Load OpenCV.js once; resolves null if it can't be loaded (never rejects). */
export function loadCv(): Promise<CV | null> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise<CV | null>((resolve) => {
    if (typeof window === "undefined") return resolve(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const ready = () => !!w.cv?.Mat && !!w.cv?.imread;
    if (ready()) return resolve(w.cv);

    const started = Date.now();
    // The build initialises its wasm asynchronously AFTER the script's onload,
    // and different builds signal that differently — poll for a usable API
    // instead of trusting any one hook.
    const poll = () => {
      if (ready()) return resolve(w.cv);
      if (Date.now() - started > READY_TIMEOUT_MS) return resolve(null);
      setTimeout(poll, 150);
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[data-opencv]`);
    if (!existing) {
      const s = document.createElement("script");
      s.src = CV_URL;
      s.async = true;
      s.dataset.opencv = "1";
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    }
    poll();
  });
  return cvPromise;
}

/** Order 4 unsorted points as top-left, top-right, bottom-right, bottom-left. */
function orderCorners(pts: Corner[]): Quad {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/**
 * Find the page's four corners in a photo, in the canvas's own pixel coords.
 * Returns null when nothing convincingly page-shaped is found — the caller then
 * leaves the photo un-cropped rather than guessing.
 */
export async function detectQuad(canvas: HTMLCanvasElement): Promise<Quad | null> {
  const cv = await loadCv();
  if (!cv) return null;
  const mats: { delete: () => void }[] = [];
  const keep = <T extends { delete: () => void }>(m: T): T => {
    mats.push(m);
    return m;
  };
  try {
    const src = keep(cv.imread(canvas));
    // Work small: edge detection is shape work, and this keeps a big photo fast
    // on a mid-range phone. Corners are scaled back up at the end.
    const scale = Math.min(1, 800 / Math.max(src.cols, src.rows));
    const work = keep(new cv.Mat());
    cv.resize(src, work, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)));

    const gray = keep(new cv.Mat());
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const edges = keep(new cv.Mat());
    cv.Canny(gray, edges, 60, 180);
    // Close small gaps so a page edge broken by shadow still forms one contour.
    const k = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    cv.dilate(edges, edges, k);

    const contours = keep(new cv.MatVector());
    const hierarchy = keep(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const area = work.cols * work.rows;
    let best: { pts: Corner[]; a: number } | null = null;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      // A page fills most of a deliberate photo; anything small is print or noise.
      if (a < area * 0.2) {
        c.delete();
        continue;
      }
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && (!best || a > best.a)) {
        const pts: Corner[] = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
        }
        best = { pts, a };
      }
      approx.delete();
      c.delete();
    }
    return best ? orderCorners(best.pts) : null;
  } catch {
    return null; // detection is best-effort; the un-cropped photo still works
  } finally {
    mats.forEach((m) => {
      try {
        m.delete();
      } catch {
        /* already freed */
      }
    });
  }
}

/**
 * Flatten the quad to a rectangle (perspective correct + deskew). Returns a new
 * canvas, or null if OpenCV isn't available — the caller keeps the original.
 */
export async function warpQuad(canvas: HTMLCanvasElement, quad: Quad): Promise<HTMLCanvasElement | null> {
  const cv = await loadCv();
  if (!cv) return null;
  const mats: { delete: () => void }[] = [];
  try {
    const [tl, tr, br, bl] = quad;
    const dist = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
    const w = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const h = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    if (w < 40 || h < 40) return null;

    const src = cv.imread(canvas);
    mats.push(src);
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    mats.push(srcTri);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    mats.push(dstTri);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    mats.push(M);
    const out = new cv.Mat();
    mats.push(out);
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    const target = document.createElement("canvas");
    target.width = w;
    target.height = h;
    cv.imshow(target, out);
    return target;
  } catch {
    return null;
  } finally {
    mats.forEach((m) => {
      try {
        m.delete();
      } catch {
        /* already freed */
      }
    });
  }
}
