"use client";

import { useCallback, useRef, useState } from "react";

// Page scanner (2026-07-21): photograph a physical book and hand the existing
// upload path ONE assembled PDF. Built for parents who have no digital copy of
// their child's book.
//
// Deliberately client-side and worker-free: `agent1_ingestion/extractor.py`
// already runs Docling with do_ocr=True, so a photographed book is an
// already-supported input — it just needs to arrive as a PDF. Nothing here
// touches the upload/validation path; we produce a File and the normal flow runs.
//
// The 200 MB ceiling (the `uploads` bucket's file_size_limit) is the hard
// constraint: raw phone photos are 3–5 MB each, so every page is downscaled and
// re-encoded on capture, the running total is shown against the budget, quality
// steps down as the total grows, and assembly is refused before it would produce
// a PDF the server must reject. There is no page cap — long scans are allowed,
// but the UI recommends one chapter at a time.
//
// Auto edge-detection + draggable corners are the NEXT slice; today each page
// gets a downscale + grayscale/contrast clean-up, which is what OCR benefits
// from most after resolution.

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // must match the bucket's file_size_limit
const SOFT_BUDGET = Math.round(MAX_TOTAL_BYTES * 0.9); // leave PDF overhead headroom
const TARGET_PAGE_BYTES = 300 * 1024; // aim: a page costs ~300 KB
const MAX_EDGE = 1600; // long-edge px — enough for OCR, far cheaper than a raw photo
const QUALITIES = [0.72, 0.6, 0.5, 0.42, 0.35];

export type ScannedPage = { id: string; url: string; bytes: number; w: number; h: number };

function mb(n: number) {
  return `${(n / 1e6).toFixed(1)} MB`;
}

// Downscale + clean up one photo, stepping quality down until it fits the target
// (or we run out of steps — a dense page legitimately costs more).
async function processPhoto(file: File, budgetPerPage: number): Promise<ScannedPage | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Lift contrast and drop colour: printed pages OCR better as clean grayscale,
  // and it roughly halves the bytes. (Feature-detected — Safari < 17 ignores it.)
  try {
    ctx.filter = "grayscale(1) contrast(1.18) brightness(1.06)";
  } catch {
    /* unsupported → plain draw */
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const target = Math.max(120 * 1024, Math.min(TARGET_PAGE_BYTES, budgetPerPage));
  let blob: Blob | null = null;
  for (const q of QUALITIES) {
    blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    if (!blob) return null;
    if (blob.size <= target) break;
  }
  if (!blob) return null;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    w,
    h,
  };
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
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  const total = pages.reduce((n, p) => n + p.bytes, 0);
  const overBudget = total >= SOFT_BUDGET;

  const addPhotos = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      setError(null);
      const files = Array.from(list);
      setBusy(`Adding ${files.length} page${files.length === 1 ? "" : "s"}…`);
      const added: ScannedPage[] = [];
      let running = total;
      for (const f of files) {
        if (running >= SOFT_BUDGET) {
          setError(
            `Stopped at ${mb(running)} — a scan has to stay under 200 MB. ` +
              "Create this PDF and upload it, then scan the next chapter separately.",
          );
          break;
        }
        const page = await processPhoto(f, TARGET_PAGE_BYTES);
        if (page) {
          added.push(page);
          running += page.bytes;
        }
      }
      if (added.length) setPages((p) => [...p, ...added]);
      else if (!added.length && !files.every((f) => f.type.startsWith("image/")))
        setError("Those files weren't photos — pick images of the pages.");
      setBusy(null);
    },
    [total],
  );

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
      return p.filter((_, k) => k !== i);
    });
  }

  async function build() {
    if (!pages.length) return;
    setBusy("Building the PDF…");
    setError(null);
    try {
      // Lazy: pdf-lib only loads once someone actually scans.
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      for (const p of pages) {
        const bytes = new Uint8Array(await (await fetch(p.url)).arrayBuffer());
        const img = await pdf.embedJpg(bytes);
        // One page per photo, sized to the image so nothing is cropped or letterboxed.
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const out = await pdf.save();
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      const blob = new Blob([buf], { type: "application/pdf" });
      if (blob.size > MAX_TOTAL_BYTES) {
        setError(
          `That PDF is ${mb(blob.size)} — over the 200 MB limit. Remove some pages, ` +
            "or scan this book one chapter at a time.",
        );
        setBusy(null);
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      onDone(new File([blob], `scan-${stamp}.pdf`, { type: "application/pdf" }));
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Couldn't build the PDF.");
    }
    setBusy(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#14181F]/45 p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-5 shadow-xl">
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
          {/* `capture` opens the camera on a phone; on desktop it's a file picker,
              which is also useful (photos already taken, or a flatbed export). */}
          <input ref={camera} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
          <input ref={library} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
          <button onClick={() => camera.current?.click()} disabled={!!busy} className="btn-primary h-10 px-4 text-sm">
            {pages.length ? "Add pages" : "Take photos"}
          </button>
          <button onClick={() => library.current?.click()} disabled={!!busy} className="btn-ghost h-10 px-4 text-sm">
            Choose photos
          </button>
        </div>

        {busy && <p className="mt-3 text-xs text-[#9A6400]">{busy}</p>}
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

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
              <div
                className={`h-full transition-[width] ${overBudget ? "bg-red-500" : "bg-[#1FB8A6]"}`}
                style={{ width: `${Math.min(100, (total / MAX_TOTAL_BYTES) * 100)}%` }}
              />
            </div>

            <ul className="mt-4 grid grid-cols-3 sm:grid-cols-5 gap-3">
              {pages.map((p, i) => (
                <li key={p.id} className="group relative rounded-lg border border-[#DCE6E2] overflow-hidden bg-[#F5F6F3]">
                  {/* Local object URL of a just-captured photo — next/image adds nothing here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={`Page ${i + 1}`} className="w-full h-24 object-cover" />
                  <span className="absolute top-1 left-1 rounded bg-[#14181F]/70 px-1.5 text-[10px] text-white">{i + 1}</span>
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-white/85 px-1 py-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move page ${i + 1} earlier`} className="px-1 text-xs disabled:opacity-30">←</button>
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
      </div>
    </div>
  );
}
