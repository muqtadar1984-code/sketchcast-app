"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

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
}: {
  label: string;
  accept: string;
  state: string | null;
  busy: boolean;
  onPick: (f: File) => void;
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
        {busy ? "Uploading…" : state ? `✓ ${state}` : "Click to upload"}
      </p>
    </label>
  );
}

// Upload the school's .docx + .pptx templates → uploads/{uid}/branding/… and
// upsert the branding row. The worker uses them to brand every output.
export default function BrandingCard({
  hasDocx,
  hasPptx,
}: {
  hasDocx: boolean;
  hasPptx: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docx, setDocx] = useState<string | null>(hasDocx ? "Uploaded" : null);
  const [pptx, setPptx] = useState<string | null>(hasPptx ? "Uploaded" : null);

  async function upload(kind: "docx" | "pptx", file: File) {
    setBusy(kind);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
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
        <span className="font-display font-medium">School branding</span>
        <span className="text-xs text-[#5B6470]">
          optional · {docx || pptx ? "templates set" : "use your school's format & theme"}
        </span>
      </summary>
      <p className="text-sm text-[#5B6470] mt-3 mb-3">
        Upload your school&apos;s Word and PowerPoint templates. New documents open from the .docx
        template; decks and the video slides adopt the .pptx theme, colours and logo.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <TemplateInput
          label="Word template (.docx)"
          accept=".docx"
          state={docx}
          busy={busy === "docx"}
          onPick={(f) => upload("docx", f)}
        />
        <TemplateInput
          label="PowerPoint template (.pptx)"
          accept=".pptx"
          state={pptx}
          busy={busy === "pptx"}
          onPick={(f) => upload("pptx", f)}
        />
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </details>
  );
}
