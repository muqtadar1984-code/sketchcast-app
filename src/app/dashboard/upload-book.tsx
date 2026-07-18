"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { cleanBookTitle } from "@/utils/book";

export default function UploadBook({
  schoolId,
  betaBlocked = false,
  parent = false,
}: {
  schoolId: string | null;
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
          : reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.ontimeout = () => reject(new Error("Upload timed out."));
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
      setError("Not signed in.");
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
        if (sErr || !signed) throw new Error(sErr?.message ?? "Could not start the upload.");
        await putWithProgress(signed.signedUrl, file);
        uploaded = true;
      } catch (ex) {
        lastErr = ex instanceof Error ? ex.message : String(ex);
        setPct(0);
      }
    }
    if (!uploaded) {
      setError(
        `${lastErr} Please check your internet connection and try again — ` +
          "large textbooks need a stable connection for a few minutes.",
      );
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
        <span className="chip bg-[#FFF1D6] text-[#9A6400] mr-2">Trial</span>
        The free trial is limited to <span className="font-medium text-[#14181F]">1 book</span>
        {parent ? (
          <> — generate test papers from its chapters.</>
        ) : (
          <> — explore all its chapters and generate the full kit for one part of one chapter.</>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onUpload} className="card p-5 mb-8">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
        <label className="block">
          <span className="text-xs text-[#5B6470]">Title (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Exploring Society"
            className="field w-full h-10 px-3 mt-1"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Author (optional)</span>
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="e.g. NCERT"
            className="field w-full h-10 px-3 mt-1"
          />
        </label>
        <button type="submit" disabled={!file || busy} className="btn-primary h-10 px-5 whitespace-nowrap">
          {busy ? (pct === null ? "Uploading…" : pct >= 100 ? "Finishing…" : `Uploading ${pct}%`) : "Upload"}
        </button>
      </div>

      {busy && pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
          <div className="h-full bg-[#1FB8A6] transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-[#14181F] file:mr-3 file:rounded-lg file:border-0 file:bg-[#E2F4F1] file:px-3 file:py-2 file:text-[#0C8175] file:font-medium"
        />
        {file ? (
          <span className="text-xs text-[#5B6470]">
            {(file.size / 1e6).toFixed(1)} MB
            {file.size > 20e6 && " — big book; keep this tab open while it uploads"}
          </span>
        ) : (
          <span className="text-xs text-[#98A0A9]">Choose a PDF to enable upload</span>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </form>
  );
}
