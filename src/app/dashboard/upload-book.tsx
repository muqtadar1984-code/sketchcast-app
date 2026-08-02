"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { cleanBookTitle } from "@/utils/book";
import PageScanner from "./page-scanner";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./content-cell";

export default function UploadBook({
  schoolId,
  t,
  betaBlocked = false,
  parent = false,
}: {
  schoolId: string | null;
  t: LibraryMessages;
  betaBlocked?: boolean; // beta teachers get exactly 1 book (server-enforced too)
  /** Parent surface (test papers): the blocked-card copy must not promise the
      teacher part-kit — parents generate exam papers only (0018). */
  parent?: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // A scan arrives as a normal PDF File, so everything below it — validation,
  // signed upload, retry, the books insert — runs completely unchanged.
  const [scanned, setScanned] = useState(false);

  // PUT via XHR so we get real upload-progress events (fetch can't report
  // progress) — on slow connections a multi-minute silent "Uploading…" reads
  // as a hang and users navigate away, killing the transfer.
  function putWithProgress(url: string, f: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("content-type", "application/pdf");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setPct(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(fmt(t.upload.httpFailed, { status: xhr.status })));
      xhr.onerror = () => reject(new Error(t.upload.networkError));
      xhr.ontimeout = () => reject(new Error(t.upload.timedOut));
      xhr.send(f);
    });
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setPct(0);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      setPct(null);
      return;
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${user.id}/${Date.now()}_${safeName}`;

    // Signed upload URL + XHR PUT (progress) with ONE automatic retry — big
    // PDFs on flaky connections are the top real-world upload failure.
    let uploaded = false;
    let lastErr = "";
    for (let attempt = 0; attempt < 2 && !uploaded; attempt++) {
      try {
        const { data: signed, error: sErr } = await supabase.storage
          .from("uploads")
          .createSignedUploadUrl(path);
        if (sErr || !signed) throw new Error(sErr?.message ?? t.upload.couldNotStart);
        await putWithProgress(signed.signedUrl, file);
        uploaded = true;
      } catch (ex) {
        lastErr = ex instanceof Error ? ex.message : String(ex);
        setPct(0);
      }
    }
    if (!uploaded) {
      setError(fmt(t.upload.retryAdvice, { error: lastErr }));
      setBusy(false);
      setPct(null);
      return;
    }

    const ins = await supabase.from("books").insert({
      title: title.trim() || cleanBookTitle(file.name),
      author: author.trim() || null,
      owner_id: user.id,
      school_id: schoolId,
      storage_path: path,
      status: "indexing", // worker extracts the chapter list, then flips to "ready"
    });
    setBusy(false);
    setPct(null);
    if (ins.error) {
      // The PUT ran before the insert — don't leave a doomed PDF in storage
      // (the DB book cap can reject the row the UI allowed, e.g. a ledger
      // slot consumed by a deleted book). Best-effort.
      try {
        await supabase.storage.from("uploads").remove([path]);
      } catch {
        /* the orphan sweep is cosmetic — the error below is what matters */
      }
      setError(ins.error.message);
      return;
    }

    setFile(null);
    setTitle("");
    setAuthor("");
    router.refresh(); // re-fetch the library (server component) → new book shows
  }

  if (betaBlocked) {
    return (
      <div className="card p-5 mb-8 text-sm text-[#5B6470]">
        <span className="chip bg-[#FFF1D6] text-[#9A6400] me-2">{t.upload.trial}</span>
        {parent ? t.upload.trialParent : t.upload.trialTeacher}
      </div>
    );
  }

  return (
    <form onSubmit={onUpload} className="card p-5 mb-8">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
        <label className="block">
          <span className="text-xs text-[#5B6470]">{t.upload.titleLabel}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t.upload.titlePlaceholder}
            className="field w-full h-10 px-3 mt-1"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">{t.upload.authorLabel}</span>
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder={t.upload.authorPlaceholder}
            className="field w-full h-10 px-3 mt-1"
          />
        </label>
        <button type="submit" disabled={!file || busy} className="btn-primary h-10 px-5 whitespace-nowrap">
          {busy
            ? pct === null
              ? t.upload.uploading
              : pct >= 100
                ? t.upload.finishing
                : fmt(t.upload.uploadingPct, { pct })
            : t.upload.upload}
        </button>
      </div>

      {busy && pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
          <div className="h-full bg-[#1FB8A6] transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setScanned(false);
          }}
          className="text-sm text-[#14181F] file:me-3 file:rounded-lg file:border-0 file:bg-[#E2F4F1] file:px-3 file:py-2 file:text-[#0C8175] file:font-medium"
        />
        {/* No digital copy? Photograph the pages — they become one PDF and take
            exactly this same upload path. */}
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#0C8175] hover:underline"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8V6a2 2 0 0 1 2-2h2M17 4h2a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2M7 20H5a2 2 0 0 1-2-2v-2" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
          {t.upload.scanPages}
        </button>
        {file ? (
          <span className="text-xs text-[#5B6470]">
            {scanned && <span className="text-[#0C8175]">{t.upload.scannedPrefix}</span>}
            {fmt(t.upload.megabytes, { n: (file.size / 1e6).toFixed(1) })}
            {file.size > 20e6 && t.upload.bigBook}
          </span>
        ) : (
          <span className="text-xs text-[#98A0A9]">{t.upload.choosePdf}</span>
        )}
      </div>

      {scanning && (
        <PageScanner
          t={t}
          onClose={() => setScanning(false)}
          onDone={(pdf) => {
            setFile(pdf);
            setScanned(true);
            setScanning(false);
            setError(null);
          }}
        />
      )}

      {/* Restrictions, stated up front so a wrong file fails at the picker, not
          mid-upload. PDF-only is the file input's accept; single-file (no
          `multiple`); 200 MB is the `uploads` bucket's file_size_limit (0001). */}
      <p className="mt-2 text-[11px] text-[#98A0A9]">{t.upload.limits}</p>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </form>
  );
}
