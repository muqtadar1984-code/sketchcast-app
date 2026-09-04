"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import ContentCell, { type CellLesson } from "./content-cell";
import { kindLabel, type LibraryMessages } from "./labels";
import AssignModal, { type ChildRow, type ClassRow } from "./assign-modal";
import { defaultParams } from "./options-spec";
import { kitRows, lessonLanguageOf, type GenerationRow } from "./kit";
import {
  AUTO_VOICE,
  LANGUAGES,
  availableVoices,
  defaultNarrationForGrade,
  narrationStyleHint,
  narrationStyles,
} from "@/utils/narration";
import { TypeIcon } from "./icons";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";
import { fmt } from "@/i18n/format";

// All content types a chapter can produce, in display order. Wording comes from
// the dictionary (kindLabel), keyed by the kind itself.
const KINDS: string[] = [
  "presentation",
  "deck",
  "lesson_plan",
  "activity",
  "worksheet",
  "exam_paper",
  "case_study",
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
  childTargets = null,
  lessons,
  t,
  beta = null,
  multiPartTrial = false,
  extraAssignableIds = [],
  bookLanguage = null,
  bookGrade = null,
  gate = null,
  premiumVoices = false,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  classes: ClassRow[];
  /** Parent-role viewers: linked children for direct assignment (null = class mode). */
  childTargets?: ChildRow[] | null;
  lessons: Record<string, CellLesson | null>;
  t: LibraryMessages;
  beta?: { pinned: { bookId: string; chapterRef: string | null; part: number | null } | null } | null;
  /** Beta + the chapter has >1 part: trial kits are per-part, so this
      chapter-level row offers no new generations (the part rows do). */
  multiPartTrial?: boolean;
  /** Done per-part lesson ids — assigned along with the chapter's own items. */
  extraAssignableIds?: string[];
  /** Detected book language (0056) — preselects the lesson language + voice. */
  bookLanguage?: string | null;
  /** Book grade — preselects an age-appropriate narration style (grades 1–4 → Storytelling). */
  bookGrade?: string | null;
  /** Junk-upload gate: non-null for a gated book — every insert path here
      (full kit AND free add-backs) confirms first and stamps its rows. */
  gate?: JunkGateInfo | null;
  /** The account's plan allows premium voices (paid tier or comp override):
      the picker offers the active premium provider's voices. The worker
      enforces the same gate regardless of what is sent. */
  premiumVoices?: boolean;
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
  // 0059: documents generate only WITH their lesson. Before a LIVE lesson
  // exists the sole action is the full kit (an errored lesson re-kits — the
  // DB requires a non-error presentation before docs ride free); after,
  // missing documents are free add-backs.
  const hasLesson = !!lessons["presentation"] && lessons["presentation"]!.status !== "error";
  // A chunked lesson renders as Part 1..N videos/decks. Its Pt stack breaks
  // the flat cell row, so the render below swaps to a bordered card (same
  // array-or-legacy-single fallback as ContentCell's done branch). Gated on
  // status "done": the worker uploads part artifacts DURING generation, so
  // without it the row would flip layouts mid-render — and an errored kit
  // with stale part videos must keep the flat row's failed/retry line.
  const presL = lessons["presentation"];
  const multiVideo =
    presL?.status === "done" &&
    Math.max(
      presL?.videos?.length ?? (presL?.video ? 1 : 0),
      presL?.decks?.length ?? (presL?.deck ? 1 : 0),
    ) > 1;
  const kitPending = !betaLocked && !hasLesson;
  // A pre-0103 kit carries its deck ON the presentation row. That deck is
  // shown by the presentation cell, so the free "+ Deck" add-back is offered
  // only where no deck of either shape exists.
  const legacyDeck = !lessons["deck"] && !!(presL?.decks?.length || presL?.deck);
  const pendingKinds = betaLocked || !hasLesson
    ? []
    : KINDS.filter((k) => k !== "presentation" && !lessons[k] && !(k === "deck" && legacyDeck));
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Age-appropriate default from the book's grade (overridable in the picker).
  const [narrationStyle, setNarrationStyle] = useState(defaultNarrationForGrade(bookGrade));
  // Unknown stored codes normalize to English — a free-text books.language
  // value must never leave the Language select without a matching option.
  const knownBookLang = LANGUAGES.some((l) => l.value === bookLanguage) ? bookLanguage : null;
  const [language, setLanguage] = useState(knownBookLang || "en");
  // "auto" until the teacher picks: the worker chooses the language's voice,
  // premium for a paid account (AUTO_VOICE). No "touched" flag is needed —
  // a concrete id IS the record that someone chose.
  const [ttsVoice, setTtsVoice] = useState<string>(AUTO_VOICE);
  const voices = availableVoices(t.utils.narration, language, { premium: premiumVoices });
  const styles = narrationStyles(t.utils.narration);
  const pickLanguage = (lang: string) => {
    setLanguage(lang);
    setTtsVoice(AUTO_VOICE); // a picked voice is language-specific — back to automatic
  };

  const chosen = pendingKinds.filter((k) => sel[k]);
  const toggle = (kind: string) => setSel((s) => ({ ...s, [kind]: !s[kind] }));

  // "Assign chapter" sends the student-workable items that are ready: the
  // lesson, the worksheet and the test paper (founder 2026-07-19). The teacher
  // plan, class activities and case study are teaching aids, never assigned.
  const studentKinds = ["presentation", "worksheet", "exam_paper"];
  const assignableIds = [
    ...studentKinds
      .map((k) => lessons[k])
      .filter((l): l is CellLesson => !!l && l.status === "done")
      .map((l) => l.id),
    ...extraAssignableIds,
  ];

  // Gated book (junk-upload gate): both buttons detour through the confirm
  // dialog; confirming lands in generate with the stamp.
  function onGenerate() {
    if (chosen.length === 0 && !kitPending) return;
    if (gate) {
      setGateOpen(true);
      return;
    }
    void generate(false);
  }

  async function generate(confirmed: boolean) {
    if (chosen.length === 0 && !kitPending) return;
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
    // Kit mode: lesson + deck + all five docs in one batch (presentation
    // FIRST — the DB's docs-with-lesson guard reads earlier rows of the same
    // insert).
    // Add-back mode: just the checked documents (free, analysis reused), in
    // the LESSON's language — the picker is not rendered once a lesson
    // exists, so `language` here is only the book's default, and a lesson
    // generated in another language must not get its deck or documents in
    // the book's (the worker falls back to books.language when a row carries
    // none).
    const addBackLanguage = lessonLanguageOf(presL) ?? language;
    const rows: GenerationRow[] = kitPending
      ? kitRows({
          bookId,
          schoolId,
          userId: user.id,
          chapterNum,
          language,
          narrationStyle,
          ttsVoice,
          // Legacy standalone docs (pre-0059) keep their slot — don't duplicate.
        }).filter(
          (r) =>
            r.kind === "presentation" || !(lessons[r.kind] && lessons[r.kind]!.status !== "error"),
        )
      : chosen.map((k) => ({
          kind: k,
          book_id: bookId,
          owner_id: user.id,
          school_id: schoolId,
          chapter_ref: String(chapterNum),
          params: { ...defaultParams(k), language: addBackLanguage },
          status: "queued",
        }));
    // The record that the teacher was warned — on EVERY row this click queues.
    const stamped = confirmed ? rows.map((r) => ({ ...r, params: stampConfirmation(r.params) })) : rows;
    const { error: gErr } = await supabase.from("generations").insert(stamped);
    setBusy(false);
    setGateOpen(false); // close either way — an error must not hide behind the overlay
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setSel({});
    router.refresh();
  }

  // The seven cells, split so the two layouts below can share them: (a) the
  // presentation (its tour anchor must render exactly once, visible in both
  // layouts) and (b) the deck and the five document kinds. Already generated
  // (or in progress): icon-forward cell — the label IS the watch/download
  // link now, so no separate type icon + caption.
  const presCell = presL ? (
    <span data-tour="lesson-output" className="flex items-center">
      <ContentCell
        bookId={bookId}
        schoolId={schoolId}
        chapterNum={chapterNum}
        kind="presentation"
        label={t.kinds.presentation}
        lesson={presL}
        trackViews={!!beta}
        bookLanguage={bookLanguage}
        genLocked={betaLocked}
        gate={gate}
        hideDeck={!!lessons["deck"]}
        t={t}
      />
    </span>
  ) : null;

  const docCells = KINDS.filter((k) => k !== "presentation").map((k) => {
    const lesson = lessons[k];
    if (!lesson) {
      // Locked chapters offer nothing; pre-lesson, single doc types
      // aren't offered either (the kit button generates everything).
      if (betaLocked || !hasLesson) return null;
      // A legacy deck is already on the presentation cell — no add-back.
      if (k === "deck" && legacyDeck) return null;
      // Lesson exists: missing documents are free add-backs.
      return (
        <label
          key={k}
          className="flex items-center gap-1.5 cursor-pointer select-none hover:opacity-80"
        >
          <input
            type="checkbox"
            checked={!!sel[k]}
            onChange={() => toggle(k)}
            className="h-3.5 w-3.5 accent-[#0C8175]"
          />
          <TypeIcon kind={k} />
          <span className={LABEL}>{kindLabel(t, k)}</span>
        </label>
      );
    }
    return (
      <span key={k} className="flex items-center">
        <ContentCell
          bookId={bookId}
          schoolId={schoolId}
          chapterNum={chapterNum}
          kind={k}
          label={kindLabel(t, k)}
          lesson={lesson}
          trackViews={!!beta}
          bookLanguage={bookLanguage}
          lessonLanguage={lessonLanguageOf(presL)}
          genLocked={betaLocked}
          gate={gate}
          t={t}
        />
      </span>
    );
  });

  const trialChip =
    betaLocked &&
    // Three honest states (review: never say "pick one part below" when
    // every part row renders dashes): pinned to another unit → locked;
    // no pin yet → invite the pick; pinned to a part of THIS chapter →
    // name it. (A chapter-level pin on THIS chapter is never locked.)
    (pinnedElsewhere ? (
      <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400]" title={t.kit.trialLockedHint}>
        {t.kit.trialLocked}
      </span>
    ) : !beta?.pinned ? (
      <span className="chip font-sans bg-[#E2F4F1] text-[#0C8175]" title={t.kit.trialPickHint}>
        {t.kit.trialPick}
      </span>
    ) : (
      <span className="chip font-sans bg-[#E2F4F1] text-[#0C8175]" title={t.kit.trialPinnedHint}>
        {fmt(t.kit.trialPinned, { n: beta.pinned.part ?? 1 })}
      </span>
    ));

  const actions = (
    <span className="ms-auto flex items-center gap-3">
      {assignableIds.length > 0 && (
        <span data-tour="assign-chapter">
          <AssignModal label={t.kit.assignChapter} generationIds={assignableIds} classes={classes} childTargets={childTargets} t={t} />
        </span>
      )}
      {kitPending && (
        <button
          data-tour="generate-lesson"
          onClick={onGenerate}
          disabled={busy}
          className="btn-primary h-8 px-3 text-xs whitespace-nowrap"
          title={t.kit.generateFullKitHint}
        >
          {busy ? t.queuing : t.kit.generateFullKit}
        </button>
      )}
      {pendingKinds.length > 0 && (
        <button
          data-tour="generate-lesson"
          onClick={onGenerate}
          disabled={busy || chosen.length === 0}
          className="btn-primary h-8 px-3 text-xs whitespace-nowrap"
          title={t.kit.generateFreeHint}
        >
          {busy ? t.queuing : fmt(t.kit.generateFree, { n: chosen.length })}
        </button>
      )}
    </span>
  );

  return (
    <div className="mt-1.5 ps-5">
      {multiVideo ? (
        // Chunked lesson: one bordered card (LessonCard's frame) — the Pt
        // chip stack first, the documents in an attached row underneath.
        <div className="rounded-xl border border-[#DCE6E2] bg-white px-3.5 py-2.5">
          {presCell}
          <div className="mt-2 pt-2 border-t border-[#EEF0EC] flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {docCells}
            {trialChip}
            {actions}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {presCell}
          {docCells}
          {trialChip}
          {actions}
        </div>
      )}

      {kitPending && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[#98A0A9]">{t.kit.lessonOptions}</span>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">{t.kit.language}</span>
            <select
              value={language}
              onChange={(e) => pickLanguage(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                  {knownBookLang === l.value ? t.kit.bookSuffix : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">{t.kit.narration}</span>
            <select
              value={narrationStyle}
              onChange={(e) => setNarrationStyle(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {styles.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#5B6470]">{t.kit.voice}</span>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              className="field h-8 px-2 text-xs"
            >
              {voices.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                  {v.tier === "premium" ? t.kit.premiumSuffix : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[10px] text-[#98A0A9]">
            {narrationStyleHint(t.utils.narration, narrationStyle)}
          </span>
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {gateOpen && gate && (
        <JunkGateDialog
          gate={gate}
          busy={busy}
          onConfirm={() => void generate(true)}
          onCancel={() => setGateOpen(false)}
        />
      )}
    </div>
  );
}
