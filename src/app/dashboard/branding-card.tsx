"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { inspectOfficeFile } from "@/utils/office-file";
import { type LibraryMessages } from "./labels";

const CT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function TemplateInput({
  label,
  accept,
  state,
  busy,
  onPick,
  t,
}: {
  label: string;
  accept: string;
  state: string | null;
  busy: boolean;
  onPick: (f: File) => void;
  t: LibraryMessages;
}) {
  return (
    <label className="block border border-dashed border-[#D2D6D1] rounded-lg p-3 cursor-pointer hover:bg-[#F5F6F3]">
      <span className="text-xs font-medium text-[#14181F]">{label}</span>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
        }}
      />
      <p className="text-xs text-[#5B6470] mt-1 truncate">
        {busy ? t.branding.uploading : state ? `✓ ${state}` : t.branding.clickToUpload}
      </p>
    </label>
  );
}

// Upload the school's .docx + .pptx templates → uploads/{uid}/branding/… and
// upsert the branding row. The worker uses them to brand every output.
export default function BrandingCard({
  hasDocx,
  hasPptx,
  t,
}: {
  hasDocx: boolean;
  hasPptx: boolean;
  t: LibraryMessages;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docx, setDocx] = useState<string | null>(hasDocx ? t.branding.uploaded : null);
  const [pptx, setPptx] = useState<string | null>(hasPptx ? t.branding.uploaded : null);

  async function upload(kind: "docx" | "pptx", file: File) {
    setBusy(kind);
    setError(null);

    // `accept=".docx"` is only a picker hint — "All files" defeats it, and mobile
    // pickers ignore it. Check the bytes before anything is stored, so the
    // teacher is told now rather than discovering it when a kit fails to build.
    const check = await inspectOfficeFile(file, kind);
    if (!check.ok) {
      setError(
        check.reason === "legacy"
          ? t.branding.errLegacy
          : check.reason === "wrongType"
            ? t.branding.errWrongType
            : t.branding.errNotOffice,
      );
      setBusy(null);
      return;
    }

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(null);
      return;
    }
    const path = `${user.id}/branding/template.${kind}`;
    const up = await supabase.storage
      .from("uploads")
      .upload(path, file, { contentType: CT[kind], upsert: true });
    if (up.error) {
      setError(up.error.message);
      setBusy(null);
      return;
    }
    const col = kind === "docx" ? { docx_path: path } : { pptx_path: path };
    const { error: bErr } = await supabase
      .from("branding")
      .upsert({ owner_id: user.id, ...col, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
    setBusy(null);
    if (bErr) {
      setError(bErr.message);
      return;
    }
    if (kind === "docx") setDocx(file.name);
    else setPptx(file.name);
    router.refresh();
  }

  return (
    <details className="card p-5 mb-8">
      <summary className="cursor-pointer flex items-center gap-2 list-none">
        <span className="font-display font-medium">{t.branding.heading}</span>
        <span className="text-xs text-[#5B6470]">{docx || pptx ? t.branding.set : t.branding.notSet}</span>
      </summary>
      <p className="text-sm text-[#5B6470] mt-3 mb-3">{t.branding.intro}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <TemplateInput
          label={t.branding.docx}
          accept=".docx"
          state={docx}
          busy={busy === "docx"}
          onPick={(f) => upload("docx", f)}
          t={t}
        />
        <TemplateInput
          label={t.branding.pptx}
          accept=".pptx"
          state={pptx}
          busy={busy === "pptx"}
          onPick={(f) => upload("pptx", f)}
          t={t}
        />
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </details>
  );
}
