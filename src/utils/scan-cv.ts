// Page-edge detection for the scanner — RUN ENTIRELY IN A WEB WORKER.
//
// WHY THE WORKER, because this was learned expensively:
// OpenCV.js is ~9.9 MB of JavaScript (98% of it one inlined base64 WASM blob).
// The <script> tag is async, so the ~2.9 MB compressed download is off-thread —
// which makes it look harmless when you measure the network. But when the bytes
// land, the browser PARSES AND EXECUTES 9.9 MB of JavaScript synchronously. On a
// phone that is seconds of frozen UI, and it lands at an unpredictable moment.
//
// It froze a teacher's phone three separate times: once on mount (the tap that
// opened the camera was swallowed, and the queued click then lost its transient
// activation so the file input refused to open a camera at all), and again while
// a photo was being processed. Each time the fix was to move WHEN it loaded,
// and each time that just relocated the window in which it could bite.
//
// A worker removes the class of bug rather than the instance. importScripts()
// blocks the WORKER thread — which is exactly what we want, because nobody is
// looking at it. The main thread posts pixels and awaits a reply.
//
// The worker is built from a Blob URL rather than a separate module file so it
// carries no bundler configuration, and so this whole concern stays in one file.
//
// EVERY entry point degrades to null rather than throwing. If the CDN is
// unreachable, the worker can't start, or OpenCV misbehaves, the scan still
// works — the page just lands un-cropped, and the user can set the corners by
// hand (the scanner already has that editor). Auto-crop is a convenience; it is
// never allowed to be the reason a teacher cannot scan a book.

export type Corner = { x: number; y: number };
export type Quad = [Corner, Corner, Corner, Corner]; // top-left, top-right, bottom-right, bottom-left

// An npm-backed CDN with an immutable version, NOT docs.opencv.org: the docs site
// has no stable per-version file (the obvious /4.10.0/opencv.js path 404s, which
// silently disabled cropping for everyone until a load test caught it).
const CV_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
const BOOT_TIMEOUT_MS = 45_000;
const DETECT_TIMEOUT_MS = 15_000;
const WARP_TIMEOUT_MS = 30_000;
/** Edge detection is shape work — it runs on a downscaled copy, and the corners
 * are scaled back up. Same 800px working size the main-thread version used. */
const DETECT_EDGE = 800;

// ── the worker ────────────────────────────────────────────────────────────────
// Written as a string on purpose: no bundler entry, no separate chunk, no
// import.meta.url resolution to get wrong across dev/build. It is small enough
// to read in one sitting, and it is the only place OpenCV is ever touched.
const WORKER_SOURCE = `
let booted = false, ok = false;

async function boot(url) {
  if (booted) return ok;
  booted = true;
  try { importScripts(url); } catch (e) { return (ok = false); }
  const t0 = Date.now();
  // The build initialises its wasm asynchronously AFTER the script evaluates,
  // and different builds signal that differently — poll for a usable API rather
  // than trust any one hook. Blocking the worker here is harmless.
  while (!(self.cv && self.cv.Mat && self.cv.matFromImageData)) {
    if (Date.now() - t0 > ${BOOT_TIMEOUT_MS}) return (ok = false);
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  return (ok = true);
}

function withMats(fn) {
  const mats = [];
  const keep = function (m) { mats.push(m); return m; };
  try { return fn(keep); }
  catch (e) { return null; }
  finally { mats.forEach(function (m) { try { m.delete(); } catch (e) {} }); }
}

// Corners in the coordinates of the image that was sent, divided by \`scale\`
// so the caller gets them back in ITS coordinate space.
function detect(imageData, scale) {
  return withMats(function (keep) {
    const work = keep(cv.matFromImageData(imageData));
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
    let best = null;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      // A page fills most of a deliberate photo; anything small is print or noise.
      if (a < area * 0.2) { c.delete(); continue; }
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && (!best || a > best.a)) {
        const pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
        }
        best = { pts: pts, a: a };
      }
      approx.delete();
      c.delete();
    }
    return best ? best.pts : null;
  });
}

function warp(imageData, quad) {
  return withMats(function (keep) {
    const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
    const dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
    const w = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const h = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    if (w < 40 || h < 40) return null;

    const src = keep(cv.matFromImageData(imageData));
    const srcTri = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const dstTri = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]));
    const M = keep(cv.getPerspectiveTransform(srcTri, dstTri));
    const out = keep(new cv.Mat());
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    // Copy out of the WASM heap before the Mat is freed in the finally above.
    return { data: new Uint8ClampedArray(out.data), width: w, height: h };
  });
}

self.onmessage = async function (e) {
  const msg = e.data;
  const reply = function (result, transfer) {
    self.postMessage({ id: msg.id, result: result }, transfer || []);
  };
  if (!(await boot(msg.url))) return reply(null);
  if (msg.type === "detect") return reply(detect(msg.imageData, msg.scale));
  if (msg.type === "warp") {
    const r = warp(msg.imageData, msg.quad);
    return r ? reply(r, [r.data.buffer]) : reply(null);
  }
  reply(null);
};
`;

type Pending = { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> };

let workerPromise: Promise<Worker | null> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Start the worker once. Resolves null if workers are unavailable — never throws. */
function getWorker(): Promise<Worker | null> {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise<Worker | null>((resolve) => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return resolve(null);
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const w = new Worker(url);
      URL.revokeObjectURL(url); // the worker holds its own reference now
      w.onmessage = (e: MessageEvent) => {
        const { id, result } = e.data as { id: number; result: unknown };
        const p = pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(id);
        p.resolve(result);
      };
      // A worker that dies takes every in-flight call with it. Settle them all as
      // "no crop" rather than leaving the scanner awaiting a reply that will
      // never come.
      w.onerror = () => {
        pending.forEach((p) => {
          clearTimeout(p.timer);
          p.resolve(null);
        });
        pending.clear();
      };
      resolve(w);
    } catch {
      resolve(null);
    }
  });
  return workerPromise;
}

/** One request/response, with a deadline. Resolves null on any failure. */
async function call<T>(
  msg: Record<string, unknown>,
  timeoutMs: number,
  transfer: Transferable[] = [],
): Promise<T | null> {
  const w = await getWorker();
  if (!w) return null;
  const id = nextId++;
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null); // a slow worker must never become a stuck scanner
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, timer });
    try {
      w.postMessage({ ...msg, id, url: CV_URL }, transfer);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

/** Start the worker and OpenCV inside it, ahead of the first photo.
 * Fire-and-forget; safe to call repeatedly. Kept for callers that want to warm
 * the pipeline at a moment of their choosing. */
export async function loadCv(): Promise<unknown> {
  return call<unknown>({ type: "boot" }, BOOT_TIMEOUT_MS);
}

/** Order 4 unsorted points as top-left, top-right, bottom-right, bottom-left. */
function orderCorners(pts: Corner[]): Quad {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** Pixels out of a canvas, optionally downscaled first. The downscale is a GPU
 * draw and the read is a memcpy — both cheap next to what they replace. */
function pixels(canvas: HTMLCanvasElement, maxEdge?: number): { data: ImageData; scale: number } | null {
  const longest = Math.max(canvas.width, canvas.height);
  const scale = maxEdge ? Math.min(1, maxEdge / longest) : 1;
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  let source: HTMLCanvasElement = canvas;
  let temp: HTMLCanvasElement | null = null;
  if (scale < 1) {
    temp = document.createElement("canvas");
    temp.width = w;
    temp.height = h;
    temp.getContext("2d")?.drawImage(canvas, 0, 0, w, h);
    source = temp;
  }
  try {
    const ctx = source.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    return { data: ctx.getImageData(0, 0, w, h), scale };
  } catch {
    return null; // a tainted canvas, in practice never here
  } finally {
    if (temp) {
      temp.width = 0;
      temp.height = 0;
    }
  }
}

/**
 * Find the page's four corners in a photo, in the canvas's own pixel coords.
 * Returns null when nothing convincingly page-shaped is found — the caller then
 * leaves the photo un-cropped rather than guessing.
 */
export async function detectQuad(canvas: HTMLCanvasElement): Promise<Quad | null> {
  const px = pixels(canvas, DETECT_EDGE);
  if (!px) return null;
  const pts = await call<Corner[]>(
    { type: "detect", imageData: px.data, scale: px.scale },
    DETECT_TIMEOUT_MS,
  );
  return pts && pts.length === 4 ? orderCorners(pts) : null;
}

/**
 * Flatten the quad to a rectangle (perspective correct + deskew). Returns a new
 * canvas, or null if the warp couldn't run — the caller keeps the original.
 */
export async function warpQuad(canvas: HTMLCanvasElement, quad: Quad): Promise<HTMLCanvasElement | null> {
  const px = pixels(canvas); // full resolution: this output IS the finished page
  if (!px) return null;
  const out = await call<{ data: Uint8ClampedArray; width: number; height: number }>(
    { type: "warp", imageData: px.data, quad },
    WARP_TIMEOUT_MS,
  );
  if (!out || !out.width || !out.height) return null;
  try {
    const target = document.createElement("canvas");
    target.width = out.width;
    target.height = out.height;
    const ctx = target.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
    return target;
  } catch {
    return null;
  }
}
