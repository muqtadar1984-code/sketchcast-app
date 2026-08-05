"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectQuad, warpQuad, loadCv, type Quad, type Corner } from "@/utils/scan-cv";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./content-cell";

// Page scanner: photograph a physical book and hand the existing upload path ONE
// assembled PDF. Built for parents who have no digital copy of their child's book.
//
// Deliberately client-side and worker-free: agent1_ingestion/extractor.py already
// runs Docling with do_ocr=True, so a photographed book is an already-supported
// input — it just needs to arrive as a PDF. Nothing here touches the upload or
// validation path; we produce a File and the normal flow runs.
//
// The 200 MB ceiling (the `uploads` bucket's file_size_limit) is the hard
// constraint: raw phone photos are 3–5 MB each, so every page is downscaled and
// re-encoded on capture, the running total is shown against the budget, and
// assembly is refused before it could produce a PDF the server must reject.
// No page cap — long scans are allowed, but the copy recommends one chapter.
//
// Slice 2: each page is auto edge-detected and flattened (perspective + deskew),
// which is the biggest OCR-quality lever after resolution. Auto-detection DOES
// go wrong, so every page keeps its original photo and can be re-cropped by hand.

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // must match the bucket's file_size_limit
const SOFT_BUDGET = Math.round(MAX_TOTAL_BYTES * 0.9); // leave PDF overhead headroom
// RESOLUTION — the two constants below move together; changing one alone makes
// things worse, not better.
//
// MAX_EDGE was 1600, and that was about HALF what OCR needs. An A4 page at
// 1600px on the long edge is 137 ppi. Cap height is roughly 0.70 x point size,
// so 10pt body text lands at ~13px and 12pt at ~16px. Tesseract asks for 300 DPI,
// and the resolution study it cites puts the usable band at 20-40px of capital
// height, best around 30px. We were under the floor.
//
// And it was worse than 1600 in practice: the photo is downscaled to MAX_EDGE
// FIRST, then warpQuad (scan-cv.ts) sizes the flattened page from the quad's edge
// lengths measured INSIDE that already-downscaled canvas. At a realistic 85-90%
// frame fill the page came out ~1360-1440px, i.e. ~120 ppi.
//
// 2600 puts a 0.85-fill page at ~2210px = ~189 ppi: 10pt -> ~18px, 12pt -> ~22px,
// inside the band. Native camera stills are 4000px+, so this is still a real
// downscale rather than an upscale.
//
// TARGET_PAGE_BYTES has to rise with it. At 2600px a 300 KB target drives the
// quality ladder to 0.35-0.42, which puts JPEG ringing straight onto glyph edges
// — you would trade the new resolution back for artifacts. 900 KB x 40 pages is
// 36 MB against a 180 MB SOFT_BUDGET, so the headroom is not the constraint.
const TARGET_PAGE_BYTES = 900 * 1024;
const MAX_EDGE = 2600; // long-edge px — see the note above before changing
const QUALITIES = [0.72, 0.6, 0.5, 0.42, 0.35];

type ScannedPage = {
  id: string;
  url: string; // the cleaned page that goes into the PDF
  bytes: number;
  /** The original (downscaled) photo, kept so the crop can be redone by hand. */
  srcUrl: string;
  srcW: number;
  srcH: number;
  /** Current corners in source pixels; null = no crop applied. */
  quad: Quad | null;
  auto: boolean; // corners came from detection rather than the user
};

// Sizes read as "12.3 MB" — the unit belongs to the message, not to this
// helper, so the template comes in from the caller's dictionary.
const mb = (n: number, template: string) => fmt(template, { n: (n / 1e6).toFixed(1) });

// In-app webviews (Gmail, WhatsApp, Facebook, Instagram, Line, the Google app)
// routinely break the camera round-trip. Copy-only: we hint at a real browser
// but never disable the button — some webviews do work.
const inAppBrowser =
  typeof navigator !== "undefined" && /\bwv\b|FBAN|FBAV|Instagram|Line\/|GSA\//.test(navigator.userAgent);

// The no-return camera hint only makes sense where `capture` actually opens a
// camera. On desktop it's a plain file dialog, and a >3 s cancel would earn
// camera/gallery copy that matches nothing the user did.
const mobileUA =
  typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

// ANDROID TAKES A DIFFERENT ROUTE THROUGH THIS SHEET, and it is not a preference.
//
// `capture` and `multiple` do not conflict — both engines set the flags
// independently and capture wins. But on Android, Chromium's capture path IGNORES
// `multiple` outright: SelectFileDialog.captureImage() never reads
// mAllowMultiple, EXTRA_ALLOW_MULTIPLE is only attached on the picker branch, and
// the result comes back from a single mCameraOutputUri. So "Take photos" yields
// exactly ONE photo per tap, and a 40-page chapter is 40 round trips.
//
// It cannot be automated away either: reopening the input needs transient
// activation, and per the HTML spec only keydown/mousedown/pointerdown/pointerup/
// touchend grant it — `change` does not. So there is no way to advance the camera
// from the handler that receives the photo.
//
// The `library` input below has `multiple` and NO `capture`, which on Android is
// the system photo picker — and Chromium DOES set EXTRA_PICK_IMAGES_MAX there
// (50, or MediaStore.getPickImagesMaxLimit() on 13+). One multi-select covers a
// whole chapter. So on Android the right flow is: shoot the chapter in the camera
// app, come back, pick them all at once — ONE round trip, and a full-resolution
// still with real autofocus rather than a preview frame.
//
// iOS is left alone: `capture` + `multiple` genuinely does multi-shot there.
const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** A small spinning ring. `shrink-0` so it never collapses when the text beside
 * it wraps, and aria-hidden because the label next to it already says what is
 * happening — a screen reader announcing "image" here would add nothing. */
function Ring() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** The rectangle the user can actually SEE, in layout-viewport coordinates.
 *
 * Every CSS unit available to a fixed overlay — `inset-0`, `100vw`, `100dvh` —
 * resolves against the LAYOUT viewport. When those differ from what is on screen
 * (pinch zoom, a browser that lays out wider than the device, an in-app browser
 * with its own ideas) a sheet pinned with CSS is correct by the spec and wrong
 * on the phone: it lands part-way off the right edge with its buttons cut in
 * half. Reported exactly that way, twice, and two CSS-only attempts failed to
 * fix it because CSS cannot see this.
 *
 * visualViewport can: width/height are what is visible, offsetLeft/offsetTop are
 * where that window sits. Returns null when unsupported, and the caller keeps
 * its CSS fallback. */
function useVisibleRect() {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!vv) return;
    const update = () =>
      setRect({ left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height });
    update();
    // resize covers zoom and the keyboard; scroll covers panning a zoomed page.
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return rect;
}

function canvasFrom(img: CanvasImageSource, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0, w, h);
  return c;
}

/** Drop a canvas's backing store immediately instead of waiting for the GC.
 * Each full-page canvas is width x height x 4 bytes — ~27 MB at 2600px — and a
 * scan makes three per page (the downscale, the warp target, the encode buffer).
 * Left to the collector that is ~80 MB of garbage per page racing the next
 * page's allocations, on a phone that is also holding OpenCV's WASM heap.
 * Setting either dimension to 0 frees it synchronously. */
function release(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

/** Grayscale + contrast (what OCR likes) and encode, stepping quality down to fit. */
async function encodePage(source: HTMLCanvasElement, target: number) {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.filter = "grayscale(1) contrast(1.18) brightness(1.06)";
  } catch {
    /* Safari < 17 ignores canvas filters — plain draw is still fine */
  }
  ctx.drawImage(source, 0, 0);
  let blob: Blob | null = null;
  for (const q of QUALITIES) {
    blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/jpeg", q));
    if (!blob || blob.size <= target) break;
  }
  release(out); // the blob is independent of the canvas once toBlob resolves
  return blob;
}

export default function PageScanner({
  onDone,
  onClose,
  t,
}: {
  /** Receives the assembled PDF — the caller feeds it to the normal upload. */
  onDone: (file: File) => void;
  onClose: () => void;
  t: LibraryMessages;
}) {
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  // Some webviews open the camera and then never fire `change` — the user comes
  // back to a page that looks like nothing happened. Track the round-trip so we
  // can hint at the gallery fallback (a hint, never an error: cancelling the
  // camera looks identical and is a perfectly normal thing to do).
  const cameraClickedAt = useRef<number | null>(null);
  const cameraReturned = useRef(false);
  const [cameraHint, setCameraHint] = useState(false);
  // Tapping "Take photos" used to produce NOTHING for 4.5 s — the no-return hint
  // needs 3 s of elapsed time plus a 1.5 s settle before it can appear, and the
  // camera itself is an app switch the page gets no event for. A teacher on a
  // device where the hand-off silently fails (a Chrome Custom Tab opened from
  // another app, a webview without camera permission) sees a dead button and
  // reasonably calls it frozen. This flips the instant the tap lands.
  const [cameraOpening, setCameraOpening] = useState(false);

  const total = pages.reduce((n, p) => n + p.bytes, 0);
  const overBudget = total >= SOFT_BUDGET;
  const autoMisses = pages.filter((p) => !p.quad).length;

  // OpenCV is NOT warmed on mount any more, and the reason is the whole bug.
  //
  // It used to load the instant this sheet appeared. The <script> is async, so
  // the ~2.9 MB download is off-thread — but when it lands the browser parses
  // and executes 9.9 MB of JavaScript SYNCHRONOUSLY on the main thread. On a
  // phone that is seconds.
  //
  // The timing was precisely wrong. The sheet paints, the teacher reads it, and
  // a second or two later — exactly when they reach for "Take photos" — OpenCV
  // arrives and locks the thread. The tap is swallowed. Worse, a click that sits
  // queued long enough loses its TRANSIENT ACTIVATION, and a file input without
  // activation refuses to open the camera at all. So the button did nothing,
  // for ever, and the app looked frozen. Reported twice as exactly that.
  //
  // It is now kicked off AFTER the capture button is pressed (see the button
  // handlers), which is strictly better than either warming or pure laziness:
  // the teacher is inside the camera app for several seconds, this page is
  // backgrounded, and nobody is waiting on the main thread. By the time they
  // come back with a photo it is ready.
  //
  // detectQuad awaits loadCv() itself, so nothing breaks if it hasn't finished —
  // addPhotos races it for 4 s and the page just lands un-cropped.

  // Freeze the page behind the sheet. Without this the background scrolls under
  // a fixed overlay, which is how a teacher ends up scrolling around hunting for
  // a dialog that never moved. Restores the previous value rather than assuming
  // "" so a future caller that already locked the body isn't unlocked by us.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Release every object URL when the sheet closes. remove() and applyQuad()
  // already revoke the ones they replace, but closing or completing a scan left
  // the rest alive: an object URL pins its blob for the life of the DOCUMENT, so
  // a 40-page chapter walked away with ~80 live blobs — tens of MB held on a
  // phone that has since navigated on. A ref, not `pages`, because an effect
  // with [] deps would close over the empty first render.
  const pagesRef = useRef<ScannedPage[]>([]);
  useEffect(() => {
    // Synced in an effect, never during render: React may render without
    // committing, and a render-phase ref write would leave us revoking URLs for
    // a page list that was never shown.
    pagesRef.current = pages;
  }, [pages]);
  useEffect(
    () => () => {
      for (const p of pagesRef.current) {
        URL.revokeObjectURL(p.url);
        URL.revokeObjectURL(p.srcUrl);
      }
    },
    [],
  );

  // When focus comes back >3 s after the camera was opened with no `change`
  // event, the capture either failed or was cancelled — either way the gallery
  // picker is the way forward. Two subtleties: on a SUCCESSFUL capture the
  // focus event arrives BEFORE the input's change event, so the hint waits a
  // beat and only fires if change still hasn't come; and it is one-shot —
  // the guard disarms after firing so later unrelated focus events (tab
  // switches) can't re-raise it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      // Focus back means the app switch is over, however it ended. Give `change`
      // a beat to land (on a SUCCESSFUL capture focus arrives first), then stop
      // claiming the camera is opening — otherwise a cancelled or failed capture
      // leaves the spinner running for ever.
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        if (!cameraReturned.current) setCameraOpening(false);
      }, 700);

      if (
        cameraClickedAt.current !== null &&
        !cameraReturned.current &&
        Date.now() - cameraClickedAt.current > 3000
      ) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!cameraReturned.current && cameraClickedAt.current !== null) {
            setCameraHint(true);
            cameraClickedAt.current = null; // disarm — hint at most once per attempt
          }
        }, 1500);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) clearTimeout(timer);
      if (settle) clearTimeout(settle);
    };
  }, []);

  // The dead-tap safety net. If the camera hand-off silently fails — a Chrome
  // Custom Tab launched from another app, a webview whose host lacks camera
  // permission — the page NEVER blurs, so the focus handler above never runs and
  // nothing would ever clear the spinner. After 10 s of no app switch and no
  // photo, say so and point at the picker, which works everywhere.
  useEffect(() => {
    if (!cameraOpening) return;
    const t = setTimeout(() => {
      if (!cameraReturned.current) {
        setCameraOpening(false);
        setCameraHint(true);
      }
    }, 10000);
    return () => clearTimeout(t);
  }, [cameraOpening]);

  const addPhotos = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      setError(null);
      const files = Array.from(list).filter((f) => f.type.startsWith("image/"));
      if (!files.length) {
        setError(t.scan.notPhotos);
        return;
      }
      const added: ScannedPage[] = [];
      let running = total;
      let skipped = 0; // photos the browser couldn't decode (HEIC on many Androids)
      for (let i = 0; i < files.length; i++) {
        setBusy(fmt(t.scan.readingPage, { n: i + 1, total: files.length }));
        if (running >= SOFT_BUDGET) {
          setError(fmt(t.scan.budgetStop, { size: mb(running, t.upload.megabytes) }));
          break;
        }
        // YIELD. detectQuad and warpQuad are async in SIGNATURE only: after the
        // single `await loadCv()` inside them, every remaining line is a
        // synchronous OpenCV call. So a multi-page scan is one unbroken block of
        // main-thread work — the progress label never paints, taps are never
        // processed, and the app is indistinguishable from frozen. One macrotask
        // between pages lets the browser paint and handle input. It costs
        // nothing: the work is bounded by OpenCV, not by this timeout.
        await new Promise((r) => setTimeout(r, 0));
        // Declared out here so the finally can free them on EVERY exit path —
        // the two `continue`s and the catch included. At 2600px each of these is
        // ~27 MB of backing store.
        let src: HTMLCanvasElement | null = null;
        let flat: HTMLCanvasElement | null = null;
        try {
          const bitmap = await createImageBitmap(files[i]).catch(() => null);
          if (!bitmap) {
            skipped++;
            continue;
          }
          const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
          const sw = Math.max(1, Math.round(bitmap.width * scale));
          const sh = Math.max(1, Math.round(bitmap.height * scale));
          src = canvasFrom(bitmap, sw, sh);
          bitmap.close?.();

          // Cap the wait on detection: the first page can be stuck behind the
          // OpenCV download. Give up on auto-crop after 4 s (loadCv keeps warming
          // in the background, so later pages still get it) — the page just lands
          // uncropped, same as any detection miss.
          //
          // Honest caveat: this race only bounds the WAIT FOR THE DOWNLOAD. Once
          // detectQuad is past its await it runs synchronously, and a setTimeout
          // cannot fire while a synchronous block owns the thread — so the 4 s is
          // not a guarantee against slow detection. The yield above is what keeps
          // the UI alive between pages.
          const quad = await Promise.race([
            detectQuad(src),
            new Promise<Quad | null>((r) => setTimeout(() => r(null), 4000)),
          ]);
          flat = quad ? await warpQuad(src, quad) : null;
          const blob = await encodePage(flat ?? src, TARGET_PAGE_BYTES);
          const srcBlob = await new Promise<Blob | null>((r) => src!.toBlob(r, "image/jpeg", 0.8));
          if (!blob || !srcBlob) {
            skipped++;
            continue;
          }

          added.push({
            id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
            url: URL.createObjectURL(blob),
            bytes: blob.size,
            srcUrl: URL.createObjectURL(srcBlob),
            srcW: sw,
            srcH: sh,
            quad: flat ? quad : null,
            auto: !!flat,
          });
          running += blob.size;
        } catch {
          // One unreadable photo must not cost the teacher the whole batch, and
          // it must not leave `busy` set — both buttons are disabled while busy,
          // so a throw here used to lock the sheet permanently with no error and
          // no way back. OpenCV throws on odd inputs more often than you would
          // like; count it as skipped and carry on to the next page.
          skipped++;
        } finally {
          // Both blobs are already extracted by here, so the canvases are dead
          // weight. Freeing them per page is what keeps a 40-page chapter from
          // stacking hundreds of MB of backing stores against OpenCV's heap.
          release(src);
          release(flat);
        }
      }
      if (added.length) setPages((p) => [...p, ...added]);
      if (skipped) {
        // Don't clobber the budget message above — dropped photos matter less
        // than a scan that's already at the 200 MB ceiling.
        setError(
          (prev) => prev ?? (skipped === 1 ? t.scan.heicOne : fmt(t.scan.heicMany, { n: skipped })),
        );
      }
      setBusy(null);
    },
    [total, t],
  );

  /** Re-crop one page from hand-placed corners. */
  async function applyQuad(index: number, quad: Quad | null) {
    const page = pages[index];
    setBusy(t.scan.applyingCrop);
    const img = new Image();
    img.src = page.srcUrl;
    await img.decode().catch(() => {});
    const src = canvasFrom(img, page.srcW, page.srcH);
    const flat = quad ? await warpQuad(src, quad) : null;
    const blob = await encodePage(flat ?? src, TARGET_PAGE_BYTES);
    if (blob) {
      URL.revokeObjectURL(page.url);
      setPages((p) =>
        p.map((q, i) =>
          i === index
            ? { ...q, url: URL.createObjectURL(blob), bytes: blob.size, quad: flat ? quad : null, auto: false }
            : q,
        ),
      );
    }
    setBusy(null);
    setEditing(null);
  }

  function move(i: number, dir: -1 | 1) {
    setPages((p) => {
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function remove(i: number) {
    setPages((p) => {
      URL.revokeObjectURL(p[i].url);
      URL.revokeObjectURL(p[i].srcUrl);
      return p.filter((_, k) => k !== i);
    });
  }

  async function build() {
    if (!pages.length) return;
    setBusy(t.scan.buildingPdf);
    setError(null);
    try {
      const { PDFDocument } = await import("pdf-lib"); // lazy: only for scanners
      const pdf = await PDFDocument.create();
      for (const p of pages) {
        const bytes = new Uint8Array(await (await fetch(p.url)).arrayBuffer());
        const img = await pdf.embedJpg(bytes);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      // pdf.save() types as Uint8Array<ArrayBufferLike>, and BlobPart demands
      // ArrayBufferView<ArrayBuffer> — SharedArrayBuffer is not assignable. The
      // previous fix was to memcpy into a fresh ArrayBuffer, which duplicated the
      // entire PDF at the exact moment peak memory is highest (pdf-lib is still
      // holding every embedded page image). A re-VIEW over the same buffer
      // satisfies the type with no copy at all. The cast is sound: pdf-lib
      // allocates a plain ArrayBuffer, never a shared one.
      const out = await pdf.save();
      const view = new Uint8Array(out.buffer as ArrayBuffer, out.byteOffset, out.byteLength);
      const blob = new Blob([view], { type: "application/pdf" });
      if (blob.size > MAX_TOTAL_BYTES) {
        setError(fmt(t.scan.tooBig, { size: mb(blob.size, t.upload.megabytes) }));
        setBusy(null);
        return;
      }
      onDone(new File([blob], `scan-${new Date().toISOString().slice(0, 10)}.pdf`, { type: "application/pdf" }));
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : t.scan.buildFailed);
    }
    setBusy(null);
  }

  const page = editing === null ? null : pages[editing];
  const visible = useVisibleRect();

  // The two capture buttons, defined once so the platform decides their ORDER
  // (see isAndroid) without either being duplicated or losing its wiring.
  const cameraButton = (
    <button
      key="camera"
      onClick={() => {
        // Arm the no-return hint only on mobile (see mobileUA).
        cameraClickedAt.current = mobileUA ? Date.now() : null;
        cameraReturned.current = false;
        setCameraHint(false);
        setCameraOpening(true);
        // click() FIRST, while the activation this handler was given is still
        // live and the main thread is still free. Nothing heavy may run above
        // this line.
        camera.current?.click();
        // Now warm OpenCV, into the window where the teacher is in the camera
        // app and this page is backgrounded. Fire-and-forget: loadCv resolves
        // null on failure and every caller degrades to an un-cropped page.
        void loadCv();
      }}
      disabled={!!busy}
      className={`${isAndroid ? "btn-ghost" : "btn-primary"} h-10 px-4 text-sm`}
    >
      {pages.length ? t.scan.addPages : t.scan.takePhotos}
    </button>
  );
  const pickerButton = (
    <button
      key="picker"
      onClick={() => {
        library.current?.click(); // first — see the camera button's note
        void loadCv();
      }}
      disabled={!!busy}
      className={`${isAndroid ? "btn-primary" : "btn-ghost"} h-10 px-4 text-sm`}
    >
      {t.scan.choosePhotos}
    </button>
  );

  return (
    // GEOMETRY, and why it is spelled out rather than `inset-0` + `vh`:
    //
    // `vh` and `inset-0`'s bottom both resolve against the LARGE viewport — the
    // page height with the browser chrome hidden. Chrome's URL bar and Android's
    // navigation bar are not subtracted. So on a phone this sheet used to be
    // pushed down by the height of that chrome AND sized taller than the screen:
    // it opened below the fold, and its bottom row — the Take photos / Choose
    // photos buttons — sat under the chrome. Reported on an S24 Ultra as "it
    // opens but goes way down the screen" with the buttons cut off.
    //
    // `dvh` is the DYNAMIC viewport: it tracks the chrome as it shows and hides,
    // so 100dvh is what the user can actually see right now. top-0 + h-[100dvh]
    // instead of inset-0 avoids over-constraining (top, bottom and height all set
    // would make the browser silently drop `bottom`).
    //
    // The sheet is fixed, so it does NOT move with the page — wherever the
    // teacher had scrolled to, it lands on screen.
    <div
      className="fixed inset-x-0 top-0 z-50 h-[100dvh] flex items-end sm:items-center justify-center bg-[#14181F]/45 sm:p-4"
      // Inline wins over the classes above, which stay as the fallback for any
      // browser without visualViewport. right/bottom are cleared so `inset-x-0`
      // cannot over-constrain the box and have one of our edges dropped.
      style={
        visible
          ? {
              left: visible.left,
              top: visible.top,
              right: "auto",
              bottom: "auto",
              width: visible.width,
              height: visible.height,
            }
          : undefined
      }
      role="dialog"
      aria-modal="true"
    >
      {/* max-w-[100vw] is a GUARD, not a diagnosis. Reported from a Chrome
          Custom Tab on an S24 Ultra: the sheet rendered wider than the screen,
          clipping the right-hand end of every line and half the Cancel button.
          `w-full` resolves against the overlay, and the overlay against the
          layout viewport — so if anything on the page has widened the layout
          viewport, the sheet inherits it. Capping at one viewport width means it
          cannot happen however the parent got wide. It never binds on desktop,
          where sm:max-w-2xl is far narrower. `break-words` stops a long
          unbroken string doing the same thing from the inside. */}
      {/* Sized against the OVERLAY (max-w-full / max-h-[92%]), not against the
          viewport — the overlay is now the visible rectangle, so a percentage of
          it is right whatever the browser claims the viewport is. */}
      <div className="w-full max-w-full sm:max-w-2xl max-h-[92%] overflow-y-auto overscroll-contain [overflow-wrap:anywhere] rounded-t-2xl sm:rounded-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl">
        {page ? (
          <CornerEditor
            page={page}
            onCancel={() => setEditing(null)}
            onApply={(q) => applyQuad(editing!, q)}
            busy={busy}
            t={t}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-medium">{t.scan.title}</h2>
                <p className="mt-1 text-xs text-[#5B6470]">
                  {t.scan.intro}
                  <span className="block text-[#98A0A9]">{t.scan.tips}</span>
                </p>
              </div>
              <button onClick={onClose} aria-label={t.common.close} className="text-[#98A0A9] hover:text-[#14181F] text-lg leading-none">×</button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {/* `capture` opens the camera on a phone; on desktop it's a file
                  picker, which is also useful (photos already taken). */}
              <input ref={camera} type="file" accept="image/*" capture="environment" multiple className="hidden"
                onChange={(e) => { cameraReturned.current = true; cameraClickedAt.current = null; setCameraHint(false); setCameraOpening(false); addPhotos(e.target.files); e.target.value = ""; }} />
              <input ref={library} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { setCameraHint(false); setCameraOpening(false); addPhotos(e.target.files); e.target.value = ""; }} />
              {/* ORDER MATTERS, and it is per-platform (see the isAndroid note).
                  On Android the camera returns ONE photo per tap, so leading with
                  it walks a teacher into 40 round trips; the picker takes the
                  whole chapter in one go. Everywhere else the camera is still the
                  obvious first move. Both buttons stay available on both — this
                  changes the DEFAULT, not what is possible.
                  Swapped in the DOM rather than with CSS `order`, so the tab
                  sequence and what a screen reader announces match what is on
                  screen. */}
              {isAndroid ? [pickerButton, cameraButton] : [cameraButton, pickerButton]}
            </div>

            {/* Why the picker is the primary button here — without this the
                teacher taps "Choose photos" and finds an empty gallery. */}
            {isAndroid && !pages.length && (
              <p className="mt-2 text-[11px] text-[#98A0A9]">{t.scan.androidFlow}</p>
            )}

            {inAppBrowser && <p className="mt-2 text-[11px] text-[#98A0A9]">{t.scan.inAppBrowser}</p>}

            {/* Handing off to the camera is an app switch the page gets no event
                for, and processing a page is seconds of OpenCV. Both used to show
                nothing, or text with no sign of life. The ring is what tells a
                teacher the tap landed. */}
            {cameraOpening && !busy && (
              <p className="mt-3 flex items-center gap-2 text-xs text-[#5B6470]">
                <Ring />
                {t.common.loading}
              </p>
            )}
            {busy && (
              <p className="mt-3 flex items-center gap-2 text-xs text-[#9A6400]">
                <Ring />
                {busy}
              </p>
            )}
            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
            {cameraHint && !busy && <p className="mt-3 text-xs text-[#5B6470]">{t.scan.cameraHint}</p>}

            {pages.length > 0 && (
              <>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <span className="text-[#5B6470]">
                    {pages.length === 1
                      ? fmt(t.scan.pageCountOne, { size: mb(total, t.upload.megabytes) })
                      : fmt(t.scan.pageCountMany, { n: pages.length, size: mb(total, t.upload.megabytes) })}
                  </span>
                  <span className={overBudget ? "text-red-600" : "text-[#98A0A9]"}>
                    {overBudget
                      ? t.scan.atLimit
                      : fmt(t.scan.leftOfLimit, { size: mb(MAX_TOTAL_BYTES - total, t.upload.megabytes) })}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
                  <div className={`h-full transition-[width] ${overBudget ? "bg-red-500" : "bg-[#1FB8A6]"}`}
                    style={{ width: `${Math.min(100, (total / MAX_TOTAL_BYTES) * 100)}%` }} />
                </div>
                {autoMisses > 0 && (
                  <p className="mt-2 text-[11px] text-[#9A6400]">
                    {autoMisses === 1 ? t.scan.uncroppedOne : fmt(t.scan.uncroppedMany, { n: autoMisses })}
                  </p>
                )}

                <ul className="mt-4 grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {pages.map((p, i) => (
                    <li key={p.id} className="group relative rounded-lg border border-[#DCE6E2] overflow-hidden bg-[#F5F6F3]">
                      {/* The copy above says "tap a page to set its edges by hand",
                          so the page itself must be the control. It was not — the
                          only way in was the Edges button below, which lived
                          behind group-hover and therefore did not exist on a
                          phone. Reported as the app freezing: the teacher was
                          tapping something that could never appear.
                          Local object URL of a just-captured photo — next/image adds nothing. */}
                      <button
                        type="button"
                        onClick={() => setEditing(i)}
                        aria-label={`${fmt(t.scan.pageAlt, { n: i + 1 })} — ${t.scan.editTitle}`}
                        className="block w-full"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt={fmt(t.scan.pageAlt, { n: i + 1 })} className="w-full h-24 object-cover" />
                      </button>
                      {/* Badges sit over the button, so they must not eat its taps. */}
                      <span className="pointer-events-none absolute top-1 start-1 rounded bg-[#14181F]/70 px-1.5 text-[10px] text-white">{i + 1}</span>
                      {!p.quad && (
                        <span className="pointer-events-none absolute top-1 end-1 rounded bg-[#FFF1D6] px-1 text-[9px] text-[#9A6400]">{t.scan.uncropped}</span>
                      )}
                      {/* Always visible. Hover-to-reveal is a desktop idiom that
                          silently removes the control on every touch device. */}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-white/90 px-1 py-0.5">
                        <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={fmt(t.scan.moveEarlier, { n: i + 1 })} className="rtl-flip px-1 text-xs disabled:opacity-30">←</button>
                        <button onClick={() => setEditing(i)} className="px-1 text-[10px] font-medium text-[#0C8175]">{t.scan.edges}</button>
                        <button onClick={() => remove(i)} aria-label={fmt(t.scan.removePage, { n: i + 1 })} className="px-1 text-xs text-red-600">✕</button>
                        <button onClick={() => move(i, 1)} disabled={i === pages.length - 1} aria-label={fmt(t.scan.moveLater, { n: i + 1 })} className="rtl-flip px-1 text-xs disabled:opacity-30">→</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={onClose} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">{t.common.cancel}</button>
              <button onClick={build} disabled={!pages.length || !!busy} className="btn-primary h-10 px-4 text-sm">
                {pages.length === 0
                  ? t.scan.usePages
                  : pages.length === 1
                    ? t.scan.useOne
                    : fmt(t.scan.useMany, { n: pages.length })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Drag the four corners over the ORIGINAL photo — auto-detection does go wrong,
    so a hand correction is always available (and is the only option when
    detection found nothing). */
function CornerEditor({
  page,
  onApply,
  onCancel,
  busy,
  t,
}: {
  page: ScannedPage;
  onApply: (quad: Quad | null) => void;
  onCancel: () => void;
  busy: string | null;
  t: LibraryMessages;
}) {
  const inset = 0.08;
  const [quad, setQuad] = useState<Quad>(
    page.quad ?? [
      { x: page.srcW * inset, y: page.srcH * inset },
      { x: page.srcW * (1 - inset), y: page.srcH * inset },
      { x: page.srcW * (1 - inset), y: page.srcH * (1 - inset) },
      { x: page.srcW * inset, y: page.srcH * (1 - inset) },
    ],
  );
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Pointer position → source-image pixels (the SVG shares the image's viewBox).
  function toSrc(e: React.PointerEvent): Corner | null {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    return {
      x: Math.max(0, Math.min(page.srcW, ((e.clientX - r.left) / r.width) * page.srcW)),
      y: Math.max(0, Math.min(page.srcH, ((e.clientY - r.top) / r.height) * page.srcH)),
    };
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-medium">{t.scan.editTitle}</h2>
          <p className="mt-1 text-xs text-[#5B6470]">{t.scan.editIntro}</p>
        </div>
        <button onClick={onCancel} aria-label={t.scan.back} className="text-[#98A0A9] hover:text-[#14181F] text-lg leading-none">×</button>
      </div>

      <div
        ref={box}
        className="relative mt-4 touch-none select-none mx-auto"
        style={{ maxWidth: "min(100%, 520px)" }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const p = toSrc(e);
          if (p) setQuad((q) => q.map((c, i) => (i === drag ? p : c)) as Quad);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={page.srcUrl} alt={t.scan.photoAlt} className="w-full block rounded-lg" />
        <svg viewBox={`0 0 ${page.srcW} ${page.srcH}`} className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          <polygon
            points={quad.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="rgba(31,184,166,0.16)"
            stroke="#1FB8A6"
            strokeWidth={Math.max(2, page.srcW * 0.004)}
          />
          {quad.map((c, i) => (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={Math.max(10, page.srcW * 0.022)}
              fill="#fff"
              stroke="#0C8175"
              strokeWidth={Math.max(2, page.srcW * 0.004)}
              style={{ cursor: "grab" }}
              onPointerDown={(e) => {
                // Touch pointers are implicitly captured by their target, which
                // would keep every move event on this circle instead of letting
                // it reach the parent's onPointerMove. Release it so dragging
                // works — but releasePointerCapture THROWS NotFoundError when
                // the element holds no capture (the mouse case, where there is
                // no implicit capture at all). `?.` only guards the method
                // existing, not the throw, and an exception here would abandon
                // setDrag and leave the corner undraggable.
                try {
                  (e.target as Element).releasePointerCapture?.(e.pointerId);
                } catch {
                  /* no capture to release — nothing to undo */
                }
                setDrag(i);
              }}
            />
          ))}
        </svg>
      </div>

      {busy && <p className="mt-3 text-xs text-[#9A6400]">{busy}</p>}

      <div className="mt-5 flex items-center justify-between gap-2">
        <button onClick={() => onApply(null)} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">
          {t.scan.useFullPhoto}
        </button>
        <span className="flex gap-2">
          <button onClick={onCancel} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">{t.common.cancel}</button>
          <button onClick={() => onApply(quad)} disabled={!!busy} className="btn-primary h-10 px-4 text-sm">{t.scan.applyCrop}</button>
        </span>
      </div>
    </>
  );
}
