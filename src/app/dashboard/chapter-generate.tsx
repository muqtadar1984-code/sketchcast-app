"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import ContentCell, { type CellLesson } from "./content-cell";
import AssignModal, { type ClassRow } from "./assign-modal";
import { defaultParams } from "./options-modal";
import { NARRATION_STYLES, DEFAULT_STYLE, LANGUAGES, availableVoices, defaultVoiceFor } from "@/utils/narration";
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

const LABEL = "text-[10px] uppercase tracking-wide text-[#98A0A9]";

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
  beta = null,
  multiPartTrial = false,
  extraAssignableIds = [],
  bookLanguage = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  classes: ClassRow[];
  lessons: Record<string, CellLesson | null>;
  beta?: { pinned: { bookId: string; chapterRef: string | null; part: number | null } | null } | null;
  /** Beta + the chapter has >1 part: trial kits are per-part, so this
      chapter-level row offers no new generations (the part rows do). */
  multiPartTrial?: boolean;
  /** Done per-part lesson ids — assigned along with the chapter's own items. */
  extraAssignableIds?: string[];
  /** Detected book language (0056) — preselects the lesson language + voice. */
  bookLanguage?: string | null;
}) {
  const router = useRouter();
  // Beta mirrors the DB pin (0057): the first generation fixes one
  // (book, chapter, part) unit. This chapter-level row (part 0) stays live
  // when it IS the pinned unit (the DB skips the multi-part guard on an
  // exact pin match — regens of a grandfathered whole-chapter kit expand
  // nothing), or when no pin exists and the chapter is single-part.
  const pinnedElsewhere =
    !!beta?.pinned &&
    (beta.pinned.bookId !== bookId || beta.pinned.chapterRef !== String(chapterNum));
  const pinIsThisChapterLevel = !!beta?.pinned && !pinnedElsewhere && beta.pinned.part == null;
  const betaLocked =
    !!beta && (beta.pinned ? !pinIsThisChapterLevel : !!multiPartTrial);
  const pendingKinds = betaLocked ? [] : KINDS.filter((k) => !lessons[k.kind]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrationStyle, setNarrationStyle] = useState(DEFAULT_STYLE);
  // Unknown stored codes normalize to English — a free-text books.language
  // value must never leave the Language select without a matching option.
  const knownBookLang = LANGUAGES.some((l) => l.value === bookLanguage) ? bookLanguage : null;
  const [language, setLanguage] = useState(knownBookLang || "en");
  const [ttsVoice, setTtsVoice] = useState(defaultVoiceFor(knownBookLang));
  const voices = availableVoices(language);
  const pickLanguage = (lang: string) => {
    setLanguage(lang);
    setTtsVoice(defaultVoiceFor(lang)); // voice follows the lesson language
  };

  const chosen = pendingKinds.filter((k) => sel[k.kind]);
  const toggle = (kind: string) => setSel((s) => ({ ...s, [kind]: !s[kind] }));

  // "Assign chapter" sends every student-facing item that's ready (the teacher
  // lesson plan is never assigned to students).
  const studentKinds = ["presentation", "activity", "worksheet", "exam_paper", "case_study"];
  const assignableIds = [
    ...studentKinds
      .map((k) => lessons[k])
      .filter((l): l is CellLesson => !!l && l.status === "done")
      .map((l) => l.id),
    ...extraAssignableIds,
  ];

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
      params:
        k.kind === "presentation"
          ? { narration_style: narrationStyle, tts_voice: ttsVoice, language }
          : { ...defaultParams(k.kind), language },
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
            if (betaLocked) return null; // locked chapters offer no new generations
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
                  className="h-3.5 w-3.5 accent-[#0C8175]"
                />
                <TypeIcon kind={k.kind} />
                <span className={LABEL}>{k.label}</span>
              </label>
            );
          }
          // Already generated (or in progress): keep the normal controls.
          return (
            <span
              key={k.kind}
              data-tour={k.kind === "presentation" ? "lesson-output" : undefined}
              className="flex items-center gap-1.5"
            >
              <TypeIcon kind={k.kind} />
              <span className={LABEL}>{k.label}</span>
              <ContentCell
                bookId={bookId}
                schoolId={schoolId}
                chapterNum={chapterNum}
                kind={k.kind}
                lesson={lesson}
                trackViews={!!beta}
                bookLanguage={bookLanguage}
                genLocked={betaLocked}
              />
            </span>
          );
        })}

        {betaLocked &&
          // Three honest states (review: never say "pick one part below" when
          // every part row renders dashes): pinned to another unit → locked;
          // no pin yet → invite the pick; pinned to a part of THIS chapter →
          // name it. (A chapter-level pin on THIS chapter is never locked.)
          (pinnedElsewhere ? (
            <span
              className="chip font-sans bg-[#FFF1D6] text-[#9A6400]"
              title="Your free trial covers the full kit (all six content types) for one part of one chapter"
            >
              Trial: 1 part — locked
            </span>
          ) : !beta?.pinned ? (
            <span
              className="chip font-sans bg-[#E2F4F1] text-[#0C8175]"
              title="This chapter is split into parts — your trial covers the full kit (all six content types) for one part of your choice"
            >
              Trial: pick one part below
            </span>
          ) : (
            <span
              className="chip font-sans bg-[#E2F4F1] text-[#0C8175]"
              title="Your trial kit lives on this part — retries and every content type for it stay open"
            >
              Trial: Part {beta.pinned.part} is your kit
            </span>
          ))}

        <span className="ml-auto flex items-center gap-3">
          {assignableIds.length > 0 && (
            <span data-tour="assign-chapter">
              <AssignModal label="Assign chapter" generationIds={assignableIds} classes={classes} />
            </span>
          )}
          {pendingKinds.length > 0 && (
            <button
              data-tour="generate-lesson"
              onClick={generate}
              disabled={busy || chosen.length === 0}
              className="btn-primary h-8 px-3 text-xs whitespace-nowrap"
              title="Generate every checked document type for this chapter"
            >
              {busy ? "Queuing…" : `Generate (${chosen.length})`}
            </button>
          )}
        </span>
      </div>

      {sel["presentation"] && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[#98A0A9]">Lesson options</span>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">Language</span>
            <select
              value={language}
              onChange={(e) => pickLanguage(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                  {knownBookLang === l.value ? " (book)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">Narration</span>
            <select
              value={narrationStyle}
              onChange={(e) => setNarrationStyle(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {NARRATION_STYLES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">Voice</span>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {voices.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                  {v.tier === "premium" ? " ★ premium" : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[10px] text-[#98A0A9]">
            {NARRATION_STYLES.find((s) => s.value === narrationStyle)?.desc}
          </span>
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
