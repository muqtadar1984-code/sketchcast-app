"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectQuad, warpQuad, loadCv, type Quad, type Corner } from "@/utils/scan-cv";

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
const TARGET_PAGE_BYTES = 300 * 1024;
const MAX_EDGE = 1600; // long-edge px — enough for OCR, far cheaper than a raw photo
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

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

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

function canvasFrom(img: CanvasImageSource, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0, w, h);
  return c;
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
  return blob;
}

export default function PageScanner({
  onDone,
  onClose,
}: {
  /** Receives the assembled PDF — the caller feeds it to the normal upload. */
  onDone: (file: File) => void;
  onClose: () => void;
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

  const total = pages.reduce((n, p) => n + p.bytes, 0);
  const overBudget = total >= SOFT_BUDGET;
  const autoMisses = pages.filter((p) => !p.quad).length;

  // Warm OpenCV as soon as the scanner opens so the first page isn't the one that
  // waits for the 8 MB download. Fire-and-forget: loadCv resolves null on failure
  // and every caller degrades to an un-cropped page.
  useEffect(() => {
    void loadCv();
  }, []);

  // When focus comes back >3 s after the camera was opened with no `change`
  // event, the capture either failed or was cancelled — either way the gallery
  // picker is the way forward. Two subtleties: on a SUCCESSFUL capture the
  // focus event arrives BEFORE the input's change event, so the hint waits a
  // beat and only fires if change still hasn't come; and it is one-shot —
  // the guard disarms after firing so later unrelated focus events (tab
  // switches) can't re-raise it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
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
    };
  }, []);

  const addPhotos = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      setError(null);
      const files = Array.from(list).filter((f) => f.type.startsWith("image/"));
      if (!files.length) {
        setError("Those files weren't photos — pick images of the pages.");
        return;
      }
      const added: ScannedPage[] = [];
      let running = total;
      let skipped = 0; // photos the browser couldn't decode (HEIC on many Androids)
      for (let i = 0; i < files.length; i++) {
        setBusy(`Reading page ${i + 1} of ${files.length}…`);
        if (running >= SOFT_BUDGET) {
          setError(
            `Stopped at ${mb(running)} — a scan has to stay under 200 MB. Create this PDF ` +
              "and upload it, then scan the next chapter separately.",
          );
          break;
        }
        const bitmap = await createImageBitmap(files[i]).catch(() => null);
        if (!bitmap) {
          skipped++;
          continue;
        }
        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const sw = Math.max(1, Math.round(bitmap.width * scale));
        const sh = Math.max(1, Math.round(bitmap.height * scale));
        const src = canvasFrom(bitmap, sw, sh);
        bitmap.close?.();

        // Cap the wait on detection: the first page can be stuck behind the 8 MB
        // OpenCV download. Give up on auto-crop after 4 s (loadCv keeps warming in
        // the background, so later pages still get it) — the page just lands
        // uncropped, same as any detection miss.
        const quad = await Promise.race([
          detectQuad(src),
          new Promise<Quad | null>((r) => setTimeout(() => r(null), 4000)),
        ]);
        const flat = quad ? await warpQuad(src, quad) : null;
        const blob = await encodePage(flat ?? src, TARGET_PAGE_BYTES);
        const srcBlob = await new Promise<Blob | null>((r) => src.toBlob(r, "image/jpeg", 0.8));
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
      }
      if (added.length) setPages((p) => [...p, ...added]);
      if (skipped) {
        // Don't clobber the budget message above — dropped photos matter less
        // than a scan that's already at the 200 MB ceiling.
        setError(
          (prev) =>
            prev ??
            `${skipped} photo${skipped === 1 ? "" : "s"} couldn't be read — if your camera saves ` +
              "HEIC ('high efficiency') photos, switch the camera to 'Most compatible'/JPEG, or " +
              "use Choose photos.",
        );
      }
      setBusy(null);
    },
    [total],
  );

  /** Re-crop one page from hand-placed corners. */
  async function applyQuad(index: number, quad: Quad | null) {
    const page = pages[index];
    setBusy("Applying crop…");
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
    setBusy("Building the PDF…");
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
      const out = await pdf.save();
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      const blob = new Blob([buf], { type: "application/pdf" });
      if (blob.size > MAX_TOTAL_BYTES) {
        setError(
          `That PDF is ${mb(blob.size)} — over the 200 MB limit. Remove some pages, or scan ` +
            "this book one chapter at a time.",
        );
        setBusy(null);
        return;
      }
      onDone(new File([blob], `scan-${new Date().toISOString().slice(0, 10)}.pdf`, { type: "application/pdf" }));
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Couldn't build the PDF.");
    }
    setBusy(null);
  }

  const page = editing === null ? null : pages[editing];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#14181F]/45 sm:p-4" role="dialog" aria-modal="true">
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-5 shadow-xl">
        {page ? (
          <CornerEditor
            page={page}
            onCancel={() => setEditing(null)}
            onApply={(q) => applyQuad(editing!, q)}
            busy={busy}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-medium">Scan pages</h2>
                <p className="mt-1 text-xs text-[#5B6470]">
                  Photograph the pages and we&apos;ll turn them into one PDF.
                  <span className="block text-[#98A0A9]">
                    Best results: one chapter at a time, page flat, good light, fills the frame.
                  </span>
                </p>
              </div>
              <button onClick={onClose} aria-label="Close" className="text-[#98A0A9] hover:text-[#14181F] text-lg leading-none">×</button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {/* `capture` opens the camera on a phone; on desktop it's a file
                  picker, which is also useful (photos already taken). */}
              <input ref={camera} type="file" accept="image/*" capture="environment" multiple className="hidden"
                onChange={(e) => { cameraReturned.current = true; cameraClickedAt.current = null; setCameraHint(false); addPhotos(e.target.files); e.target.value = ""; }} />
              <input ref={library} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { setCameraHint(false); addPhotos(e.target.files); e.target.value = ""; }} />
              <button
                onClick={() => {
                  // Arm the no-return hint only on mobile (see mobileUA).
                  cameraClickedAt.current = mobileUA ? Date.now() : null;
                  cameraReturned.current = false;
                  setCameraHint(false);
                  camera.current?.click();
                }}
                disabled={!!busy}
                className="btn-primary h-10 px-4 text-sm"
              >
                {pages.length ? "Add pages" : "Take photos"}
              </button>
              <button onClick={() => library.current?.click()} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">
                Choose photos
              </button>
            </div>

            {inAppBrowser && (
              <p className="mt-2 text-[11px] text-[#98A0A9]">
                Cameras often fail inside the Gmail/WhatsApp browser — open sketchcast.app in Chrome
                or Safari, or use Choose photos.
              </p>
            )}

            {busy && <p className="mt-3 text-xs text-[#9A6400]">{busy}</p>}
            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
            {cameraHint && !busy && (
              <p className="mt-3 text-xs text-[#5B6470]">
                Nothing came back from the camera? Use Choose photos to pick from your gallery instead.
              </p>
            )}

            {pages.length > 0 && (
              <>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <span className="text-[#5B6470]">
                    {pages.length} page{pages.length === 1 ? "" : "s"} · {mb(total)}
                  </span>
                  <span className={overBudget ? "text-red-600" : "text-[#98A0A9]"}>
                    {overBudget ? "At the 200 MB limit" : `${mb(MAX_TOTAL_BYTES - total)} left of 200 MB`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
                  <div className={`h-full transition-[width] ${overBudget ? "bg-red-500" : "bg-[#1FB8A6]"}`}
                    style={{ width: `${Math.min(100, (total / MAX_TOTAL_BYTES) * 100)}%` }} />
                </div>
                {autoMisses > 0 && (
                  <p className="mt-2 text-[11px] text-[#9A6400]">
                    {autoMisses} page{autoMisses === 1 ? " wasn't" : "s weren't"} cropped automatically — tap
                    a page to set its edges by hand.
                  </p>
                )}

                <ul className="mt-4 grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {pages.map((p, i) => (
                    <li key={p.id} className="group relative rounded-lg border border-[#DCE6E2] overflow-hidden bg-[#F5F6F3]">
                      {/* Local object URL of a just-captured photo — next/image adds nothing. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={`Page ${i + 1}`} className="w-full h-24 object-cover" />
                      <span className="absolute top-1 left-1 rounded bg-[#14181F]/70 px-1.5 text-[10px] text-white">{i + 1}</span>
                      {!p.quad && (
                        <span className="absolute top-1 right-1 rounded bg-[#FFF1D6] px-1 text-[9px] text-[#9A6400]">uncropped</span>
                      )}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-white/90 px-1 py-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move page ${i + 1} earlier`} className="px-1 text-xs disabled:opacity-30">←</button>
                        <button onClick={() => setEditing(i)} className="px-1 text-[10px] font-medium text-[#0C8175]">Edges</button>
                        <button onClick={() => remove(i)} aria-label={`Remove page ${i + 1}`} className="px-1 text-xs text-red-600">✕</button>
                        <button onClick={() => move(i, 1)} disabled={i === pages.length - 1} aria-label={`Move page ${i + 1} later`} className="px-1 text-xs disabled:opacity-30">→</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={onClose} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">Cancel</button>
              <button onClick={build} disabled={!pages.length || !!busy} className="btn-primary h-10 px-4 text-sm">
                Use these {pages.length || ""} page{pages.length === 1 ? "" : "s"}
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
}: {
  page: ScannedPage;
  onApply: (quad: Quad | null) => void;
  onCancel: () => void;
  busy: string | null;
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
          <h2 className="font-display text-base font-medium">Set the page edges</h2>
          <p className="mt-1 text-xs text-[#5B6470]">
            Drag the four corners to the corners of the page.
          </p>
        </div>
        <button onClick={onCancel} aria-label="Back" className="text-[#98A0A9] hover:text-[#14181F] text-lg leading-none">×</button>
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
        <img src={page.srcUrl} alt="Page photo" className="w-full block rounded-lg" />
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
                (e.target as Element).releasePointerCapture?.(e.pointerId);
                setDrag(i);
              }}
            />
          ))}
        </svg>
      </div>

      {busy && <p className="mt-3 text-xs text-[#9A6400]">{busy}</p>}

      <div className="mt-5 flex items-center justify-between gap-2">
        <button onClick={() => onApply(null)} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">
          Use the full photo
        </button>
        <span className="flex gap-2">
          <button onClick={onCancel} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">Cancel</button>
          <button onClick={() => onApply(quad)} disabled={!!busy} className="btn-primary h-10 px-4 text-sm">Apply crop</button>
        </span>
      </div>
    </>
  );
}
