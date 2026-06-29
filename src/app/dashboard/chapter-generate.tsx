"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import ContentCell, { type CellLesson } from "./content-cell";
import AssignModal, { type ClassRow } from "./assign-modal";
import { defaultParams } from "./options-modal";
import { TypeIcon } from "./icons";

// All content types a chapter can produce, in display order.
const KINDS: { kind: string; label: string }[] = [
  { kind: "presentation", label: "Lesson" },
  { kind: "lesson_plan", label: "Plan" },
  { kind: "activity", label: "Activities" },
  { kind: "worksheet", label: "Worksheet" },
  { kind: "exam_paper", label: "Exam" },
  { kind: "case_study", label: "Case study" },
];

const LABEL = "text-[10px] uppercase tracking-wide text-[#9A958A]";

// One row of controls for a chapter: every content type the chapter doesn't have
// yet gets a checkbox, and a single "Generate (N)" button queues all the checked
// ones at once (each with the same default options OptionsModal would use).
// Types that already exist keep their normal status / download / regenerate cell.
export default function ChapterGenerate({
  bookId,
  schoolId,
  chapterNum,
  classes,
  lessons,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  classes: ClassRow[];
  lessons: Record<string, CellLesson | null>;
}) {
  const router = useRouter();
  const pendingKinds = KINDS.filter((k) => !lessons[k.kind]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = pendingKinds.filter((k) => sel[k.kind]);
  const toggle = (kind: string) => setSel((s) => ({ ...s, [kind]: !s[kind] }));

  async function generate() {
    if (chosen.length === 0) return;
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
    // One generation row per checked type — the on_generation_created trigger
    // creates a job for each.
    const rows = chosen.map((k) => ({
      kind: k.kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterNum),
      params: defaultParams(k.kind),
      status: "queued",
    }));
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setSel({});
    router.refresh();
  }

  return (
    <div className="mt-1.5 pl-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {KINDS.map((k) => {
          const lesson = lessons[k.kind];
          if (!lesson) {
            // Pending: a checkbox to include this type in the batch generate.
            return (
              <label
                key={k.kind}
                className="flex items-center gap-1.5 cursor-pointer select-none hover:opacity-80"
              >
                <input
                  type="checkbox"
                  checked={!!sel[k.kind]}
                  onChange={() => toggle(k.kind)}
                  className="h-3.5 w-3.5 accent-[#2E6B4E]"
                />
                <TypeIcon kind={k.kind} />
                <span className={LABEL}>{k.label}</span>
              </label>
            );
          }
          // Already generated (or in progress): keep the normal controls.
          return (
            <span key={k.kind} className="flex items-center gap-1.5">
              <TypeIcon kind={k.kind} />
              <span className={LABEL}>{k.label}</span>
              <ContentCell
                bookId={bookId}
                schoolId={schoolId}
                chapterNum={chapterNum}
                kind={k.kind}
                lesson={lesson}
              />
              {k.kind === "presentation" && lesson.status === "done" && (
                <AssignModal label="Assign" generationIds={[lesson.id]} classes={classes} />
              )}
            </span>
          );
        })}

        {pendingKinds.length > 0 && (
          <button
            onClick={generate}
            disabled={busy || chosen.length === 0}
            className="btn-primary h-8 px-3 text-xs whitespace-nowrap ml-auto"
            title="Generate every checked document type for this chapter"
          >
            {busy ? "Queuing…" : `Generate (${chosen.length})`}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
