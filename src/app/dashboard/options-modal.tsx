"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

type Field =
  | { type: "number"; key: string; label: string; min: number; max: number; def: number }
  | { type: "select"; key: string; label: string; options: string[]; def: string }
  | { type: "checkbox"; key: string; label: string; def: boolean };

type Spec = { title: string; fields: Field[]; build: (v: Record<string, unknown>) => Record<string, unknown> };

// Per-kind customization. `build` shapes the flat field values into the params
// the worker expects (exam nests its objective counts).
const SPECS: Record<string, Spec> = {
  lesson_plan: {
    title: "Lesson plan options",
    fields: [
      { type: "number", key: "duration_minutes", label: "Duration (minutes)", min: 10, max: 180, def: 45 },
      { type: "checkbox", key: "include_homework", label: "Include homework", def: true },
      { type: "checkbox", key: "include_differentiation", label: "Include differentiation", def: true },
    ],
    build: (v) => v,
  },
  activity: {
    title: "Activities options",
    fields: [{ type: "number", key: "num_activities", label: "Number of activities", min: 1, max: 8, def: 4 }],
    build: (v) => v,
  },
  worksheet: {
    title: "Worksheet options",
    fields: [
      { type: "number", key: "num_questions", label: "Number of questions", min: 1, max: 40, def: 10 },
      { type: "select", key: "difficulty", label: "Difficulty", options: ["easy", "medium", "hard"], def: "medium" },
      { type: "checkbox", key: "include_answer_key", label: "Include answer key", def: true },
    ],
    build: (v) => v,
  },
  case_study: {
    title: "Case study options",
    fields: [
      { type: "select", key: "length", label: "Length", options: ["short", "medium", "long"], def: "medium" },
      { type: "number", key: "num_questions", label: "Discussion questions", min: 1, max: 15, def: 4 },
    ],
    build: (v) => v,
  },
  exam_paper: {
    title: "Exam paper — question mix",
    fields: [
      { type: "number", key: "fill_blank", label: "Fill in the blanks", min: 0, max: 20, def: 5 },
      { type: "number", key: "true_false", label: "True / False", min: 0, max: 20, def: 5 },
      { type: "number", key: "match_column", label: "Match the columns", min: 0, max: 20, def: 4 },
      { type: "number", key: "subjective", label: "Long-answer questions", min: 0, max: 20, def: 3 },
      { type: "checkbox", key: "include_answer_key", label: "Include answer key", def: true },
    ],
    build: (v) => ({
      objective: { fill_blank: v.fill_blank, true_false: v.true_false, match_column: v.match_column },
      subjective: v.subjective,
      include_answer_key: v.include_answer_key,
    }),
  },
};

// The params OptionsModal would submit with nothing changed — lets a batch
// "Generate" queue document kinds without opening each modal. Presentation and
// unknown kinds carry no params (null).
export function defaultParams(kind: string): Record<string, unknown> | null {
  const spec = SPECS[kind];
  if (!spec) return null;
  const vals = Object.fromEntries(spec.fields.map((f) => [f.key, f.def]));
  return spec.build(vals);
}

export default function OptionsModal({
  bookId,
  schoolId,
  chapterRef,
  kind,
  label,
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef: number | string;
  kind: string;
  label: string;
}) {
  const spec = SPECS[kind];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, unknown>>(() =>
    Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.def])),
  );

  if (!spec) return null;
  const set = (k: string, v: unknown) => setVals((s) => ({ ...s, [k]: v }));

  async function submit() {
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
    const { error: gErr } = await supabase.from("generations").insert({
      kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterRef),
      params: spec.build(vals),
      status: "queued",
    });
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-[#2E6B4E] hover:underline whitespace-nowrap"
      >
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-[#EBE3D3] p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium mb-3" style={{ fontFamily: "Georgia, serif" }}>
              {spec.title}
            </h3>
            <div className="space-y-1.5">
              {spec.fields.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-sm text-[#2C2A26]">{f.label}</span>
                  {f.type === "number" && (
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={Number(vals[f.key])}
                      onChange={(e) =>
                        set(f.key, Math.max(f.min, Math.min(f.max, parseInt(e.target.value || "0", 10))))
                      }
                      className="w-16 h-8 px-2 rounded-lg border border-[#EBE3D3] text-sm text-right outline-none focus:border-[#2E6B4E]"
                    />
                  )}
                  {f.type === "select" && (
                    <select
                      value={String(vals[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="h-8 px-2 rounded-lg border border-[#EBE3D3] text-sm bg-white outline-none focus:border-[#2E6B4E]"
                    >
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}
                  {f.type === "checkbox" && (
                    <input
                      type="checkbox"
                      checked={Boolean(vals[f.key])}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                  )}
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="h-9 px-3 rounded-lg border border-[#EBE3D3] text-sm hover:bg-[#FBF8F1]"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="h-9 px-4 rounded-lg bg-[#2E6B4E] text-white text-sm font-medium hover:bg-[#255A41] disabled:opacity-50"
              >
                {busy ? "Starting…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
