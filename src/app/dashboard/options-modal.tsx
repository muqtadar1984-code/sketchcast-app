"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { LANGUAGES } from "@/utils/narration";
import { type LibraryMessages } from "./content-cell";

// A field's `label` is a KEY into t.options.fields, never a word: two kinds can
// share a param key with different wording (case_study's num_questions reads
// "Discussion questions"), so the display name is looked up separately from the
// param the worker receives. Select choices work the same way — the option
// VALUES stay the English tokens the worker expects; only their labels are
// translated. The modal's heading is looked up by kind (t.options.titles).
type FieldLabel = keyof LibraryMessages["options"]["fields"];
type ChoiceSet = keyof LibraryMessages["options"]["choices"];

type Field =
  | { type: "number"; key: string; label: FieldLabel; min: number; max: number; def: number }
  | { type: "select"; key: string; label: FieldLabel; choices: ChoiceSet; options: string[]; def: string }
  | { type: "checkbox"; key: string; label: FieldLabel; def: boolean };

type Spec = { fields: Field[]; build: (v: Record<string, unknown>) => Record<string, unknown> };

// Per-kind customization. `build` shapes the flat field values into the params
// the worker expects (exam nests its objective counts).
const SPECS: Record<string, Spec> = {
  lesson_plan: {
    fields: [
      { type: "number", key: "duration_minutes", label: "duration_minutes", min: 10, max: 180, def: 45 },
      { type: "checkbox", key: "include_homework", label: "include_homework", def: true },
      { type: "checkbox", key: "include_differentiation", label: "include_differentiation", def: true },
    ],
    build: (v) => v,
  },
  activity: {
    fields: [{ type: "number", key: "num_activities", label: "num_activities", min: 1, max: 8, def: 4 }],
    build: (v) => v,
  },
  worksheet: {
    fields: [
      { type: "number", key: "num_questions", label: "num_questions", min: 1, max: 40, def: 10 },
      { type: "select", key: "difficulty", label: "difficulty", choices: "difficulty", options: ["easy", "medium", "hard"], def: "medium" },
      { type: "checkbox", key: "include_answer_key", label: "include_answer_key", def: true },
    ],
    build: (v) => v,
  },
  case_study: {
    fields: [
      { type: "select", key: "length", label: "length", choices: "length", options: ["short", "medium", "long"], def: "medium" },
      { type: "number", key: "num_questions", label: "discussion_questions", min: 1, max: 15, def: 4 },
    ],
    build: (v) => v,
  },
  exam_paper: {
    fields: [
      { type: "number", key: "fill_blank", label: "fill_blank", min: 0, max: 20, def: 5 },
      { type: "number", key: "true_false", label: "true_false", min: 0, max: 20, def: 5 },
      { type: "number", key: "match_column", label: "match_column", min: 0, max: 20, def: 4 },
      { type: "number", key: "subjective", label: "subjective", min: 0, max: 20, def: 3 },
      { type: "checkbox", key: "include_answer_key", label: "include_answer_key", def: true },
    ],
    build: (v) => ({
      objective: { fill_blank: v.fill_blank, true_false: v.true_false, match_column: v.match_column },
      subjective: v.subjective,
      include_answer_key: v.include_answer_key,
    }),
  },
};

// The params OptionsModal would submit with nothing changed — lets a batch
// "Generate" queue document kinds without opening each modal. Unknown kinds
// carry no params (null); presentation defaults live in utils/narration.ts.
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
  t,
  part = null,
  bookLanguage = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef: number | string;
  kind: string;
  /** The trigger's text — already in the reader's language (the cell translates
      the kind before handing it down). */
  label: string;
  t: LibraryMessages;
  /** Generate for ONE part of the chapter (per-part lesson units). */
  part?: number | null;
  /** Detected book language (0056) — preselects the document language. */
  bookLanguage?: string | null;
}) {
  const spec = SPECS[kind];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, unknown>>(() =>
    Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.def])),
  );
  const knownBookLang = LANGUAGES.some((l) => l.value === bookLanguage) ? bookLanguage : null;
  const [language, setLanguage] = useState(knownBookLang || "en");

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
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }
    const { error: gErr } = await supabase.from("generations").insert({
      kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterRef),
      params: {
        ...(spec.build(vals) ?? {}),
        ...(part ? { part } : {}),
        language,
      },
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
        className="text-xs font-medium text-[#0C8175] hover:underline whitespace-nowrap"
      >
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-[#E6E8E4] p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium mb-3" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
              {(t.options.titles as Record<string, string>)[kind] ?? label}
            </h3>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-sm text-[#14181F]">{t.options.language}</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="field h-8 px-2 text-sm"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                      {bookLanguage === l.value ? t.options.bookSuffix : ""}
                    </option>
                  ))}
                </select>
              </div>
              {spec.fields.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-sm text-[#14181F]">{t.options.fields[f.label]}</span>
                  {f.type === "number" && (
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={Number(vals[f.key])}
                      onChange={(e) =>
                        set(f.key, Math.max(f.min, Math.min(f.max, parseInt(e.target.value || "0", 10))))
                      }
                      className="w-16 h-8 px-2 rounded-lg border border-[#E6E8E4] text-sm text-end outline-none focus:border-[#1FB8A6]"
                    />
                  )}
                  {f.type === "select" && (
                    <select
                      value={String(vals[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="h-8 px-2 rounded-lg border border-[#E6E8E4] text-sm bg-white outline-none focus:border-[#1FB8A6]"
                    >
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {(t.options.choices[f.choices] as Record<string, string>)[o] ?? o}
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
                className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
              >
                {busy ? t.options.starting : t.options.generate}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
