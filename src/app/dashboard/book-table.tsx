"use client";

import { useState } from "react";
import GenerateButton from "./generate-button";
import GenerateAllButton from "./generate-all-button";
import DeleteBook from "./delete-book";
import DeleteLesson from "./delete-lesson";
import { type CellLesson } from "./content-cell";
import { kindLabel, statusLabel, type LibraryMessages } from "./labels";
import LessonCard from "./lesson-card";
import BookTools from "./book-tools";
import AssignModal, { type ChildRow, type ClassRow } from "./assign-modal";
import ChapterGenerate from "./chapter-generate";
import BatchGenerate from "./batch-generate";
import ExamGenerate, { type ExamChapterOpt } from "./exam-generate";
import BookHealthBadge, { type BookHealth } from "./book-health-badge";
import { type JunkGateInfo } from "./junk-gate-dialog";
import { docTypeKey, gateReasons, isGated, isStructureGate } from "@/utils/junk-gate";
import { BookCover } from "./icons";
import { cleanBookTitle } from "@/utils/book";
import { jobStageLabel, etaLabel } from "@/utils/job-stage";
import { languageLabel } from "@/utils/narration";
import { fmt } from "@/i18n/format";

export type Lesson = CellLesson & { title: string; kind: string };
export type PartRow = {
  n: number;
  /** How many parts the chapter has — carried alongside n so a part can be
   *  named "<chapter> · Part 3 of 7" rather than a bare, placeless ordinal. */
  total: number;
  titles: string[];
  presentation: CellLesson | null;
  lessonPlan: CellLesson | null;
  activity: CellLesson | null;
  worksheet: CellLesson | null;
  exam: CellLesson | null;
  caseStudy: CellLesson | null;
};
export type ChapterRow = {
  num: number;
  title: string;
  presentation: CellLesson | null;
  lessonPlan: CellLesson | null;
  activity: CellLesson | null;
  worksheet: CellLesson | null;
  exam: CellLesson | null;
  caseStudy: CellLesson | null;
  /** Per-part lesson units (index-time part map) — empty for single-part chapters. */
  parts: PartRow[];
};
export type BookRow = {
  id: string;
  title: string;
  author: string | null;
  status: string | null;
  grade: string | null;
  subject: string | null;
  /** Detected book language (0056) — chip + generation defaults. */
  language: string | null;
  /** Set when this book belongs to the SCHOOL shelf rather than the reader
   *  (0070). A teacher works from it exactly like their own — the badge only
   *  answers "why is this here, and who do I ask about it". */
  sharedBy?: string | null;
  coverUrl: string | null;
  storagePath: string | null;
  createdAt: string;
  health: BookHealth | null;
  doneChapters: number;
  totalChapters: number;
  presentationIds: string[];
  chapters: ChapterRow[];
  /** Chapters with no kit yet. partCount is the index-time part map's size —
   *  "Generate all" queues one kit PER PART, so it needs the count. */
  pendingChapters: { num: number; title: string; partCount: number }[];
  otherLessons: (CellLesson & { title: string })[];
  /** Lessons queued via "Generate selected" (params.batch) — own section at the book's end. */
  batchLessons: (CellLesson & { title: string; kind: string; chapterRef: string | null })[];
  /** Revision papers (0061): standalone worksheets/exams over a group of chapters. */
  revisionPapers: RevisionPaper[];
  /** Exam tool (0062): the covered chapters/parts an exam can be built from. */
  examUnits: ExamChapterOpt[];
  /** Generated exams (0062): the exam paper + its answer key. */
  exams: ExamPaper[];
};
export type RevisionPaper = {
  id: string;
  label: string;
  status: string;
  progress: number;
  stage?: import("@/utils/job-stage").JobStage;
  doc: string | null;
  /** Separate answer key (post-split papers) — adult-only, labeled like the exams'. */
  answerKey: string | null;
  artifactPaths: string[];
};
export type ExamPaper = {
  id: string;
  label: string;
  /** "1. Cells; 2. Materials (Parts 1, 3)" — what the exam tests. */
  coverage: string;
  status: string;
  progress: number;
  stage?: import("@/utils/job-stage").JobStage;
  doc: string | null;
  answerKey: string | null;
  artifactPaths: string[];
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#EEF0EC] text-[#5B6470]",
  processing: "bg-[#FFF1D6] text-[#9A6400]",
  done: "bg-[#E2F4F1] text-[#0C8175]",
  error: "bg-[#FCEBEA] text-[#B42318]",
};

export type BetaState = {
  // The trial's pinned unit (0057): book + chapter + part. part null = a
  // chapter-level (single-part or legacy whole-chapter) unit.
  pinned: { bookId: string; chapterRef: string | null; part: number | null } | null;
};

// Watch/Deck/Download links for one finished lesson — multi-part aware (a long
// chapter ships Part 1..N videos and a deck per part). Multi-part lessons
// render ONE LINE PER PART, stacked — "Part 2 · Watch · Deck" — instead of a
// single crowded row of Pt links.
function ArtifactLinks({ lesson, t }: { lesson: CellLesson; t: LibraryMessages }) {
  const videos = lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : [];
  const decks = lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : [];
  const nParts = Math.max(videos.length, decks.length);

  if (nParts > 1) {
    return (
      <span className="flex flex-col gap-0.5">
        {Array.from({ length: nParts }, (_, i) => (
          <span key={i} className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-xs text-[#5B6470] w-11">{fmt(t.part, { n: i + 1 })}</span>
            {videos[i] && (
              <a href={videos[i]} target="_blank" className="text-xs font-medium text-[#0C8175] hover:underline">
                ▶ {t.watch}
              </a>
            )}
            {decks[i] && (
              <a href={decks[i]} className="text-xs font-medium text-[#0C8175] hover:underline">
                ⬇ {t.deck}
              </a>
            )}
          </span>
        ))}
        {lesson.doc && (
          <a href={lesson.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
            ⬇ {t.download}
          </a>
        )}
        {lesson.answerKey && (
          <a href={lesson.answerKey} className="text-xs font-medium text-[#0C8175] hover:underline">
            ⬇ {t.book.answerKey}
          </a>
        )}
      </span>
    );
  }

  return (
    <>
      {videos[0] && (
        <a href={videos[0]} target="_blank" className="text-xs font-medium text-[#0C8175] hover:underline">
          ▶ {t.watch}
        </a>
      )}
      {decks[0] && (
        <a href={decks[0]} className="text-xs font-medium text-[#0C8175] hover:underline">
          ⬇ {t.deck}
        </a>
      )}
      {lesson.doc && (
        <a href={lesson.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
          ⬇ {t.download}
        </a>
      )}
      {/* The split answer-key / teacher-notes document (2026-08-18): this
          component only ever renders on adult surfaces, so it is always
          offered, labeled with the same key as the exams section's. */}
      {lesson.answerKey && (
        <a href={lesson.answerKey} className="text-xs font-medium text-[#0C8175] hover:underline">
          ⬇ {t.book.answerKey}
        </a>
      )}
    </>
  );
}

export default function BookTable({
  books,
  schoolId,
  classes,
  childTargets = null,
  t,
  lang,
  beta = null,
  examEnabled = false,
  trial = false,
}: {
  books: BookRow[];
  schoolId: string | null;
  classes: ClassRow[];
  /** Parent-role viewers: linked children for direct assignment (null = class mode). */
  childTargets?: ChildRow[] | null;
  t: LibraryMessages;
  /** BCP-47 tag for the reader's locale — the one date on this surface (the
      book's upload day) formats in their own calendar conventions. */
  lang: string;
  beta?: BetaState | null; // non-null for a beta teacher (1-chapter cap active)
  /** Exam tool (0062) — gated on FEATURE_EXAM until migration 0062 is applied. */
  examEnabled?: boolean;
  /** plan_tier === "trial" (junk-upload gate): the confirm dialog adds its
      stronger "your only trial kit" line. NOT beta_tester — that flag goes
      stale on upgrade. */
  trial?: boolean;
}) {
  // Expand the only book by default; otherwise everything starts collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    books.length === 1 ? { [books[0].id]: true } : {},
  );
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <div className="card overflow-hidden">
      {books.map((b) => {
        const isOpen = !!open[b.id];
        const ready = b.status === "ready";
        // Junk-upload gate (worker-stamped health.gate): ONE object per book,
        // threaded to every control that inserts generation rows. Books whose
        // health lacks the gate (all older books) get null — zero change.
        const gate: JunkGateInfo | null = isGated(b.health)
          ? {
              docType: docTypeKey(b.health),
              structure: isStructureGate(b.health),
              reasons: gateReasons(b.health),
              trial,
              t,
            }
          : null;
        return (
          <div key={b.id} className="border-b border-[#EEF0EC] last:border-b-0">
            <div className={`grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-3 items-center transition-colors ${ready ? "hover:bg-[#EEF3F1]" : ""}`}>
              <button
                onClick={() => ready && toggle(b.id)}
                disabled={!ready}
                className="flex items-center gap-3 min-w-0 text-start disabled:cursor-default"
              >
                <BookCover src={b.coverUrl} title={b.title} />
                {/* Disclosure caret, not a play button: it points along the
                    reading direction, so RTL mirrors it (rtl-flip) and reverses
                    the open rotation so it still ends up pointing down. */}
                <span className={`rtl-flip text-[#98A0A9] text-xs transition-transform ${isOpen ? "rotate-90 rtl:-rotate-90" : ""}`}>
                  {ready ? "▶" : "•"}
                </span>
                <span className="min-w-0">
                  <span className="font-display font-medium truncate block">{cleanBookTitle(b.title, t.utils.book)}</span>
                  <span className="text-xs text-[#5B6470]">
                    {b.author || t.book.unknownAuthor}
                    {/* A school book is used exactly like your own; this only
                        answers "where did this come from" — hence a quiet
                        inline note rather than a competing chip. */}
                    {b.sharedBy && <span className="text-[#0C8175]"> · {b.sharedBy}</span>}
                  </span>
                </span>
              </button>
              <span className="text-sm text-[#5B6470] text-end whitespace-nowrap self-center">
                {b.status === "indexing" ? (
                  t.book.findingChapters
                ) : b.status === "error" ? (
                  "—"
                ) : (
                  // One message, one emphasis: the fraction can't be styled apart
                  // from the word without pinning their order for every language.
                  <span
                    className={
                      b.doneChapters === b.totalChapters && b.totalChapters > 0
                        ? "text-[#0C8175] font-medium"
                        : "text-[#14181F] font-medium"
                    }
                  >
                    {fmt(t.book.chaptersDone, { done: b.doneChapters, total: b.totalChapters })}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2 whitespace-nowrap self-center">
                {ready && <BookHealthBadge health={b.health} t={t} />}
                {b.language && languageLabel(b.language) && (
                  <span className="chip bg-[#E2F4F1] text-[#0C8175]">{languageLabel(b.language)}</span>
                )}
                {ready && b.totalChapters > 0 && b.doneChapters === b.totalChapters && (
                  <AssignModal
                    label={t.book.assignBook}
                    generationIds={b.presentationIds}
                    classes={classes}
                    childTargets={childTargets}
                    t={t}
                  />
                )}
                <span className="text-xs text-[#5B6470]">
                  {new Date(b.createdAt).toLocaleDateString(lang)}
                </span>
                {/* Only on your OWN books. books_write is (owner_id =
                    auth.uid()), so deleting a colleague's school book was
                    always going to be refused — offering the button just
                    promised something the database would never allow.
                    Retiring a shared book is leadership's act, on the School
                    books page, where it withdraws kits instead of destroying
                    the source. */}
                {!b.sharedBy && <DeleteBook bookId={b.id} title={b.title} t={t} />}
              </div>
            </div>

            {/* Junk-upload gate: the caution rides the ROW (outside the
                disclosure), so a collapsed gated book still warns before
                anyone opens it to generate. Same amber as the scanned-PDF
                warning below — it is the same kind of news. */}
            {gate && (
              <div className="px-5 pb-3">
                <div className="flex items-start gap-2 rounded-lg bg-[#FFF1D6] text-[#9A6400] px-3 py-2 text-xs">
                  <span aria-hidden>⚠️</span>
                  {/* A suspect CHAPTER MAP is a structure problem, not a
                      junk-material one — "doesn't look like a textbook" over
                      a real book was the wrong claim (see junk-gate.ts). */}
                  <span>{gate.structure ? t.gate.structureBanner : t.gate.banner}</span>
                </div>
              </div>
            )}

            {b.status === "error" && (
              <div className="px-5 pb-3 flex items-center gap-3">
                <span className="text-xs text-[#B42318]">{t.book.noChapters}</span>
                {/* Whole-book generation would blow past the 1-chapter beta cap. */}
                {!beta && <GenerateButton bookId={b.id} schoolId={schoolId} label={t.book.generateFullBook} gate={gate} />}
              </div>
            )}

            {isOpen && ready && (
              <div className="px-5 pb-4 bg-[#EEF3F1]">
                {/* Scanned PDFs have no text layer, so chapter detection falls back
                    to image recognition — best-effort and often wrong. Warn up front,
                    before the teacher generates against a bad chapter list. */}
                {b.health?.facts?.has_text_layer === false && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg bg-[#FFF1D6] text-[#9A6400] px-3 py-2 text-xs">
                    <span aria-hidden>⚠️</span>
                    {/* The emphasis is a LEAD-IN rather than a word inside the
                        sentence: bolding mid-sentence would pin the phrase's
                        position in every language. */}
                    <span>
                      <strong>{t.book.scannedLead}</strong> {t.book.scannedWarning} {t.book.scannedAdvice}
                    </span>
                  </div>
                )}
                {!beta && (
                  // One primary action (generate what's missing); the occasional
                  // paper tools sit behind "More" so they stop competing with it.
                  <div className="flex items-center justify-end gap-2 py-1.5">
                    {b.pendingChapters.length > 0 && (
                      <GenerateAllButton bookId={b.id} schoolId={schoolId} chapters={b.pendingChapters} language={b.language} bookGrade={b.grade} gate={gate} />
                    )}
                    <BookTools t={t}>
                    {/* Revision papers: worksheets/test papers over a group of
                        chapters, built from generated lessons. */}
                    <BatchGenerate
                      bookId={b.id}
                      schoolId={schoolId}
                      chapters={b.chapters
                        .filter(
                          (ch) =>
                            (ch.presentation && ch.presentation.status !== "error") ||
                            ch.parts.some((p) => p.presentation && p.presentation.status !== "error"),
                        )
                        .map((ch) => ({ num: ch.num, title: ch.title }))}
                      language={b.language}
                      gate={gate}
                      t={t}
                    />
                    {/* Exam: a cumulative exam paper + separate answer key over
                        the chosen covered chapters/parts (0062). Gated on
                        FEATURE_EXAM until migration 0062 is applied. */}
                    {examEnabled && (
                      <ExamGenerate bookId={b.id} schoolId={schoolId} chapters={b.examUnits} language={b.language} gate={gate} t={t} />
                    )}
                    </BookTools>
                  </div>
                )}
                <ul className="border-t border-[#EEF0EC] divide-y divide-[#EEF0EC]">
                  {b.chapters.map((ch) => (
                    <li key={ch.num} className="py-2.5">
                      <span className="text-sm text-[#14181F] block truncate">
                        <span className="text-[#98A0A9]">{ch.num + 1}.</span> {ch.title}
                      </span>
                      <ChapterGenerate
                        bookId={b.id}
                        schoolId={schoolId}
                        chapterNum={ch.num}
                        classes={classes}
                        childTargets={childTargets}
                        beta={beta}
                        multiPartTrial={!!beta && ch.parts.length > 1}
                        lessons={{
                          presentation: ch.presentation,
                          lesson_plan: ch.lessonPlan,
                          activity: ch.activity,
                          worksheet: ch.worksheet,
                          exam_paper: ch.exam,
                          case_study: ch.caseStudy,
                        }}
                        extraAssignableIds={ch.parts
                          .flatMap((p) => [p.presentation, p.worksheet, p.exam])
                          .filter((l): l is CellLesson => !!l && l.status === "done")
                          .map((l) => l.id)}
                        bookLanguage={b.language}
                        bookGrade={b.grade}
                        gate={gate}
                        t={t}
                      />
                      {/* Per-part lesson units (index-time part map): one row
                          per part, each with its OWN kit, generated on demand.
                          Beta mirrors the DB pin (0057) exactly: only the
                          pinned (book, chapter, part) triple stays live —
                          everything else shows dashes, never Generate. */}
                      {ch.parts.length > 1 && (
                        <div className="mt-2 space-y-2">
                          {ch.parts.map((p) => {
                            const locked =
                              !!beta?.pinned &&
                              (beta.pinned.bookId !== b.id ||
                                beta.pinned.chapterRef !== String(ch.num) ||
                                beta.pinned.part !== p.n);
                            return (
                              <LessonCard
                                key={p.n}
                                bookId={b.id}
                                schoolId={schoolId}
                                chapterNum={ch.num}
                                part={p}
                                classes={classes}
                                childTargets={childTargets}
                                chapterTitle={ch.title}
                                bookTitle={b.title}
                                locked={locked}
                                trackViews={!!beta}
                                bookLanguage={b.language}
                                bookGrade={b.grade}
                                gate={gate}
                                t={t}
                              />
                            );
                          })}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Revision papers (0061): standalone worksheets/exams over a
                    group of chapters — cumulative or a per-chapter pack. */}
                {b.revisionPapers.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#EEF0EC]">
                    <p className="text-xs text-[#5B6470] mb-1">{t.book.revisionPapers}</p>
                    {b.revisionPapers.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">{p.label}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {p.status === "done" ? (
                            <>
                              {p.doc && (
                                <a href={p.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ {t.download}
                                </a>
                              )}
                              {p.answerKey && (
                                <a href={p.answerKey} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ {t.book.answerKey}
                                </a>
                              )}
                              <AssignModal label={t.assign} generationIds={[p.id]} classes={classes} childTargets={childTargets} t={t} />
                            </>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status] ?? ""}`}>
                              {statusLabel(t, p.status)}
                              {p.status === "processing"
                                ? ` · ${jobStageLabel(p.progress, p.stage, t.utils.job)}${
                                    etaLabel("exam_paper", p.progress, p.stage, t.utils.job)
                                      ? ` · ${etaLabel("exam_paper", p.progress, p.stage, t.utils.job)}`
                                      : ""
                                  }`
                                : ""}
                            </span>
                          )}
                          <DeleteLesson genId={p.id} status={p.status} t={t} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Exams (0062): a physical, teacher-run assessment — the exam
                    paper + a separate answer key, with a line naming the
                    chapters/parts it covers. Download-and-print only: exams are
                    NOT assigned to students (revision papers are the assignable,
                    student-facing path). The answer key is teacher-only. */}
                {b.exams.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#EEF0EC]">
                    <p className="text-xs text-[#5B6470] mb-1">{t.book.exams}</p>
                    {b.exams.map((e) => (
                      <div key={e.id} className="flex items-start justify-between gap-4 py-1.5">
                        <span className="min-w-0 flex-1">
                          <span className="text-sm text-[#14181F] block truncate">{e.label}</span>
                          {e.coverage && (
                            <span className="block text-[10px] text-[#98A0A9] truncate" title={e.coverage}>
                              {fmt(t.book.covers, { list: e.coverage })}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {e.status === "done" ? (
                            <>
                              {e.doc && (
                                <a href={e.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ {t.book.examPaper}
                                </a>
                              )}
                              {e.answerKey && (
                                <a href={e.answerKey} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ {t.book.answerKey}
                                </a>
                              )}
                            </>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[e.status] ?? ""}`}>
                              {statusLabel(t, e.status)}
                              {e.status === "processing"
                                ? ` · ${jobStageLabel(e.progress, e.stage, t.utils.job)}${
                                    etaLabel("exam", e.progress, e.stage, t.utils.job)
                                      ? ` · ${etaLabel("exam", e.progress, e.stage, t.utils.job)}`
                                      : ""
                                  }`
                                : ""}
                            </span>
                          )}
                          <DeleteLesson genId={e.id} status={e.status} t={t} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {b.otherLessons.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#EEF0EC]">
                    <p className="text-xs text-[#5B6470] mb-1">{t.otherLessons}</p>
                    {b.otherLessons.map((l) => (
                      <div key={l.id} className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">{l.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {l.status === "done" ? <ArtifactLinks lesson={l} t={t} /> : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                              {statusLabel(t, l.status)}
                              {l.status === "processing"
                                ? ` · ${jobStageLabel(l.progress, l.stage, t.utils.job)}`
                                : ""}
                            </span>
                          )}
                          <DeleteLesson genId={l.id} status={l.status} t={t} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* The batch's own receipt: everything queued via "Generate
                    selected", grouped at the END of the book (they also fill
                    their chapter cells above as they finish). */}
                {b.batchLessons.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#EEF0EC]">
                    <p className="text-xs text-[#5B6470] mb-1">{t.book.generatedAsSelected}</p>
                    {b.batchLessons.map((l) => {
                      const ch = b.chapters.find((c) => String(c.num) === l.chapterRef);
                      return (
                        <div key={l.id} className="flex items-center justify-between gap-4 py-1">
                          <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">
                            <span className="text-[#98A0A9]">
                              {ch ? `${ch.num + 1}. ` : ""}
                            </span>
                            {ch?.title ?? l.title}
                            <span className="text-xs text-[#98A0A9]"> · {kindLabel(t, l.kind)}</span>
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            {l.status === "done" ? <ArtifactLinks lesson={l} t={t} /> : (
                              <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                                {statusLabel(t, l.status)}
                                {l.status === "processing"
                                  ? ` · ${jobStageLabel(l.progress, l.stage, t.utils.job)}`
                                  : ""}
                              </span>
                            )}
                            <DeleteLesson genId={l.id} status={l.status} t={t} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
