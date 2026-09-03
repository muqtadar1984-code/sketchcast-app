"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { cleanBookTitle } from "@/utils/book";
import { fingerprintFile, titlesLookSame } from "@/utils/book-fingerprint";
import PageScanner from "./page-scanner";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./labels";

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
  // Duplicate check (0070). The shelf makes a colleague's book VISIBLE; this is
  // what stops us paying to index it a second time — and it has to run before
  // the transfer, not after, or the expensive part has already happened.
  const [checking, setChecking] = useState(false);
  const [dupe, setDupe] = useState<{ title: string; exact: boolean } | null>(null);

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

  /** Does this school already hold this book? Returns null when it doesn't,
   *  when there's no school, or when anything at all goes wrong — a failed
   *  check must never stand between a teacher and their upload. */
  async function findDuplicate(f: File, fp: string | null): Promise<{ title: string; exact: boolean } | null> {
    if (!schoolId) return null; // no shelf, nothing to collide with
    try {
      const supabase = createClient();
      // RLS already scopes this to books the reader may see, and the
      // restrictive removed-books policy keeps retired ones out. The school
      // filter is what makes it THIS school's shelf — a licensed copy must
      // never be offered across tenants.
      const { data } = await supabase
        .from("books")
        .select("title, content_hash")
        .eq("school_id", schoolId)
        .limit(300);
      const shelf = (data ?? []) as { title: string; content_hash: string | null }[];
      if (!shelf.length) return null;

      // Same bytes: the publisher's soft copy passed around the staff room.
      const exact = fp ? shelf.find((b) => b.content_hash && b.content_hash === fp) : undefined;
      if (exact) return { title: exact.title, exact: true };

      // Same book, different file: two teachers scanning one textbook. This is
      // the case that actually costs the indexing bill twice.
      const candidate = title.trim() || f.name;
      const near = shelf.find((b) => titlesLookSame(b.title, candidate));
      return near ? { title: near.title, exact: false } : null;
    } catch {
      return null;
    }
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    // Computed once and reused: it answers the duplicate question now, and is
    // stored on the row so the NEXT teacher's upload can be matched against it.
    // Never fatal — a browser without crypto.subtle still uploads fine.
    let contentHash: string | null = null;
    try {
      contentHash = await fingerprintFile(file);
    } catch {
      /* fall through with a null hash */
    }

    // Ask once. If the teacher says "upload anyway", `dupe` is cleared and we
    // fall straight through on the next submit — the answer is always theirs.
    if (!dupe) {
      setChecking(true);
      const hit = await findDuplicate(file, contentHash);
      setChecking(false);
      if (hit) {
        setDupe(hit);
        return;
      }
    }

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
      title: title.trim() || cleanBookTitle(file.name, t.utils.book),
      author: author.trim() || null,
      owner_id: user.id,
      school_id: schoolId,
      storage_path: path,
      content_hash: contentHash, // so the next teacher's upload can be matched
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
    setDupe(null);
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
        <button type="submit" disabled={!file || busy || checking} className="btn-primary h-10 px-5 whitespace-nowrap">
          {checking
            ? t.upload.duplicate.checking
            : busy
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
            setDupe(null); // a different file deserves a fresh question
          }}
          className="text-sm text-[#14181F] file:me-3 file:rounded-lg file:border-0 file:bg-[#E2F4F1] file:px-3 file:py-2 file:text-[#0C8175] file:font-medium"
        />
        {/* No digital copy? Photograph the pages — they become one PDF and take
            exactly this same upload path. */}
        {/* min-h-11 (44px) is the accessible minimum tap target, and this button
            badly needed it: as a bare text link it was ~20px tall — half the
            height of every control it opens (the sheet's own buttons are h-10) —
            which on a narrow, high-DPI phone screen is a genuinely hard target
            to hit. A teacher reported "nothing happened" here. The negative
            margin keeps the label sitting exactly where it did; only the hit
            area grows. */}
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="inline-flex min-h-11 items-center gap-1.5 -mx-2 px-2 text-sm font-medium text-[#0C8175] hover:underline"
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

      {/* The whole point of the shared shelf. Nothing has been uploaded yet —
          this is the last moment before the transfer and the indexing bill.
          A SUGGESTION, never a block: editions differ, and being wrong about
          that must not stand between a teacher and their book. */}
      {dupe && (
        <div className="mt-3 rounded-lg border border-[#BDE8E2] bg-[#F1FBF9] px-4 py-3">
          <p className="text-sm font-medium text-[#14181F]">{t.upload.duplicate.title}</p>
          <p className="text-sm text-[#5B6470] mt-0.5 [overflow-wrap:anywhere]">
            {fmt(dupe.exact ? t.upload.duplicate.sameFile : t.upload.duplicate.sameBook, { title: dupe.title })}
          </p>
          <p className="text-xs text-[#98A0A9] mt-1">{t.upload.duplicate.hint}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setDupe(null);
                setFile(null);
                setTitle("");
                setAuthor("");
              }}
              className="btn-primary h-9 px-3 text-sm"
            >
              {t.upload.duplicate.useExisting}
            </button>
            {/* Clearing `dupe` is what lets the next submit through. */}
            <button type="submit" onClick={() => setDupe(null)} className="btn-ghost h-9 px-3 text-sm">
              {t.upload.duplicate.uploadAnyway}
            </button>
          </div>
        </div>
      )}

      {/* Restrictions, stated up front so a wrong file fails at the picker, not
          mid-upload. PDF-only is the file input's accept; single-file (no
          `multiple`); 200 MB is the `uploads` bucket's file_size_limit (0001). */}
      <p className="mt-2 text-[11px] text-[#98A0A9]">{t.upload.limits}</p>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </form>
  );
}
