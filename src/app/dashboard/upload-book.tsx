"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function UploadBook({
  schoolId,
  betaBlocked = false,
}: {
  schoolId: string | null;
  betaBlocked?: boolean; // beta teachers get exactly 1 book (server-enforced too)
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${user.id}/${Date.now()}_${safeName}`;

    const up = await supabase.storage
      .from("uploads")
      .upload(path, file, { contentType: "application/pdf", upsert: false });
    if (up.error) {
      setError(up.error.message);
      setBusy(false);
      return;
    }

    const ins = await supabase.from("books").insert({
      title: title.trim() || file.name.replace(/\.pdf$/i, ""),
      author: author.trim() || null,
      owner_id: user.id,
      school_id: schoolId,
      storage_path: path,
      status: "indexing", // worker extracts the chapter list, then flips to "ready"
    });
    setBusy(false);
    if (ins.error) {
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
        <span className="chip bg-[#FFF1D6] text-[#9A6400] mr-2">Beta</span>
        The beta is limited to <span className="font-medium text-[#14181F]">1 book</span> — you can
        explore all its chapters and generate everything for one of them.
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
        <button type="submit" disabled={!file || busy} className="btn-primary h-10 px-5">
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-[#14181F] file:mr-3 file:rounded-lg file:border-0 file:bg-[#E2F4F1] file:px-3 file:py-2 file:text-[#0C8175] file:font-medium"
        />
        {file && <span className="text-xs text-[#5B6470]">{(file.size / 1e6).toFixed(1)} MB</span>}
      </div>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </form>
  );
}
