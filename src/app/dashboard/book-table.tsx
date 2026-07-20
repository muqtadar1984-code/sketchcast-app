"use client";

import { useState } from "react";
import GenerateButton from "./generate-button";
import GenerateAllButton from "./generate-all-button";
import DeleteBook from "./delete-book";
import DeleteLesson from "./delete-lesson";
import ContentCell, { type CellLesson } from "./content-cell";
import GenerateKitButton from "./generate-kit-button";
import AssignModal, { type ClassRow } from "./assign-modal";
import ChapterGenerate from "./chapter-generate";
import BatchGenerate from "./batch-generate";
import ExamGenerate, { type ExamChapterOpt } from "./exam-generate";
import BookHealthBadge, { type BookHealth } from "./book-health-badge";
import { BookCover } from "./icons";
import { cleanBookTitle } from "@/utils/book";
import { jobStageLabel, etaLabel } from "@/utils/job-stage";
import { languageLabel } from "@/utils/narration";

export type Lesson = CellLesson & { title: string; kind: string };
export type PartRow = {
  n: number;
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
  coverUrl: string | null;
  storagePath: string | null;
  createdAt: string;
  health: BookHealth | null;
  doneChapters: number;
  totalChapters: number;
  presentationIds: string[];
  chapters: ChapterRow[];
  pendingChapters: { num: number; title: string }[];
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

const KIND_LABEL: Record<string, string> = {
  presentation: "Lesson",
  lesson_plan: "Plan",
  activity: "Activities",
  worksheet: "Worksheet",
  exam_paper: "Test paper",
  case_study: "Case study",
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
function ArtifactLinks({ lesson }: { lesson: CellLesson }) {
  const videos = lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : [];
  const decks = lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : [];
  const nParts = Math.max(videos.length, decks.length);

  if (nParts > 1) {
    return (
      <span className="flex flex-col gap-0.5">
        {Array.from({ length: nParts }, (_, i) => (
          <span key={i} className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-xs text-[#5B6470] w-11">Part {i + 1}</span>
            {videos[i] && (
              <a href={videos[i]} target="_blank" className="text-xs font-medium text-[#0C8175] hover:underline">
                ▶ Watch
              </a>
            )}
            {decks[i] && (
              <a href={decks[i]} className="text-xs font-medium text-[#0C8175] hover:underline">
                ⬇ Deck
              </a>
            )}
          </span>
        ))}
        {lesson.doc && (
          <a href={lesson.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
            ⬇ Download
          </a>
        )}
      </span>
    );
  }

  return (
    <>
      {videos[0] && (
        <a href={videos[0]} target="_blank" className="text-xs font-medium text-[#0C8175] hover:underline">
          ▶ Watch
        </a>
      )}
      {decks[0] && (
        <a href={decks[0]} className="text-xs font-medium text-[#0C8175] hover:underline">
          ⬇ Deck
        </a>
      )}
      {lesson.doc && (
        <a href={lesson.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
          ⬇ Download
        </a>
      )}
    </>
  );
}

export default function BookTable({
  books,
  schoolId,
  classes,
  beta = null,
  examEnabled = false,
}: {
  books: BookRow[];
  schoolId: string | null;
  classes: ClassRow[];
  beta?: BetaState | null; // non-null for a beta teacher (1-chapter cap active)
  /** Exam tool (0062) — gated on FEATURE_EXAM until migration 0062 is applied. */
  examEnabled?: boolean;
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
        return (
          <div key={b.id} className="border-b border-[#EEF0EC] last:border-b-0">
            <div className={`grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-3 items-center transition-colors ${ready ? "hover:bg-[#F5F6F3]" : ""}`}>
              <button
                onClick={() => ready && toggle(b.id)}
                disabled={!ready}
                className="flex items-center gap-3 min-w-0 text-left disabled:cursor-default"
              >
                <BookCover src={b.coverUrl} title={b.title} />
                <span className={`text-[#98A0A9] text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>
                  {ready ? "▶" : "•"}
                </span>
                <span className="min-w-0">
                  <span className="font-display font-medium truncate block">{cleanBookTitle(b.title)}</span>
                  <span className="text-xs text-[#5B6470]">{b.author || "Unknown author"}</span>
                </span>
              </button>
              <span className="text-sm text-[#5B6470] text-right whitespace-nowrap self-center">
                {b.status === "indexing" ? (
                  "Finding chapters…"
                ) : b.status === "error" ? (
                  "—"
                ) : (
                  <>
                    <span
                      className={
                        b.doneChapters === b.totalChapters && b.totalChapters > 0
                          ? "text-[#0C8175] font-medium"
                          : "text-[#14181F] font-medium"
                      }
                    >
                      {b.doneChapters}/{b.totalChapters}
                    </span>{" "}
                    chapters
                  </>
                )}
              </span>
              <div className="flex items-center gap-2 whitespace-nowrap self-center">
                {ready && <BookHealthBadge health={b.health} />}
                {b.language && languageLabel(b.language) && (
                  <span className="chip bg-[#E2F4F1] text-[#0C8175]">{languageLabel(b.language)}</span>
                )}
                {ready && b.totalChapters > 0 && b.doneChapters === b.totalChapters && (
                  <AssignModal
                    label="Assign book"
                    generationIds={b.presentationIds}
                    classes={classes}
                  />
                )}
                <span className="text-xs text-[#5B6470]">
                  {new Date(b.createdAt).toLocaleDateString()}
                </span>
                <DeleteBook bookId={b.id} storagePath={b.storagePath} />
              </div>
            </div>

            {b.status === "error" && (
              <div className="px-5 pb-3 flex items-center gap-3">
                <span className="text-xs text-[#B42318]">Couldn&apos;t detect chapters.</span>
                {/* Whole-book generation would blow past the 1-chapter beta cap. */}
                {!beta && <GenerateButton bookId={b.id} schoolId={schoolId} label="Generate full book" />}
              </div>
            )}

            {isOpen && ready && (
              <div className="px-5 pb-4 bg-[#F5F6F3]">
                {/* Scanned PDFs have no text layer, so chapter detection falls back
                    to image recognition — best-effort and often wrong. Warn up front,
                    before the teacher generates against a bad chapter list. */}
                {b.health?.facts?.has_text_layer === false && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg bg-[#FFF1D6] text-[#9A6400] px-3 py-2 text-xs">
                    <span aria-hidden>⚠️</span>
                    <span>
                      This looks like a <strong>scanned PDF</strong> (no text layer). Chapters are detected by image
                      recognition, so the list below — and any generated content — may be unreliable. For best
                      results, upload a text-based (digitally exported) PDF, and use <strong>Report an issue</strong> on
                      anything that comes out wrong.
                    </span>
                  </div>
                )}
                {!beta && (
                  <div className="space-y-0.5">
                    {b.pendingChapters.length > 0 && (
                      <div className="flex justify-end pb-1">
                        <GenerateAllButton bookId={b.id} schoolId={schoolId} chapters={b.pendingChapters} language={b.language} bookGrade={b.grade} />
                      </div>
                    )}
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
                    />
                    {/* Exam: a cumulative exam paper + separate answer key over
                        the chosen covered chapters/parts (0062). Gated on
                        FEATURE_EXAM until migration 0062 is applied. */}
                    {examEnabled && (
                      <ExamGenerate bookId={b.id} schoolId={schoolId} chapters={b.examUnits} language={b.language} />
                    )}
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
                      />
                      {/* Per-part lesson units (index-time part map): one row
                          per part, each with its OWN kit, generated on demand.
                          Beta mirrors the DB pin (0057) exactly: only the
                          pinned (book, chapter, part) triple stays live —
                          everything else shows dashes, never Generate. */}
                      {ch.parts.length > 1 && (
                        <div className="mt-1.5 space-y-1.5">
                          {ch.parts.map((p) => {
                            const locked =
                              !!beta?.pinned &&
                              (beta.pinned.bookId !== b.id ||
                                beta.pinned.chapterRef !== String(ch.num) ||
                                beta.pinned.part !== p.n);
                            // Per-part assignment (founder 2026-07-19): every
                            // generated part can be assigned on its own — the
                            // lesson, worksheet and test paper for that part
                            // (never the plan, activities or case study).
                            const partAssignable = [p.presentation, p.worksheet, p.exam]
                              .filter((l): l is CellLesson => !!l && l.status === "done")
                              .map((l) => l.id);
                            return (
                              <div key={p.n} className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs">
                                <span className="w-36 shrink-0 text-[#5B6470]">
                                  Part {p.n}
                                  {p.titles.length > 0 && (
                                    <span className="block text-[10px] text-[#98A0A9] truncate" title={p.titles.join(", ")}>
                                      {p.titles.join(", ")}
                                    </span>
                                  )}
                                </span>
                                {/* 0059: the kit is the unit — one credit queues the
                                    lesson plus all five documents. Loose documents
                                    only exist as free add-backs after a LIVE lesson
                                    (an errored one re-kits instead). */}
                                {!locked && !(p.presentation && p.presentation.status !== "error") && (
                                  <GenerateKitButton
                                    bookId={b.id}
                                    schoolId={schoolId}
                                    chapterNum={ch.num}
                                    part={p.n}
                                    language={b.language}
                                    bookGrade={b.grade}
                                    skipKinds={(
                                      [
                                        ["lesson_plan", p.lessonPlan],
                                        ["activity", p.activity],
                                        ["worksheet", p.worksheet],
                                        ["exam_paper", p.exam],
                                        ["case_study", p.caseStudy],
                                      ] as const
                                    )
                                      .filter(([, l]) => l && l.status !== "error")
                                      .map(([k]) => k)}
                                  />
                                )}
                                {(
                                  [
                                    ["presentation", "Lesson", p.presentation],
                                    ["lesson_plan", "Plan", p.lessonPlan],
                                    ["activity", "Activities", p.activity],
                                    ["worksheet", "Worksheet", p.worksheet],
                                    ["exam_paper", "Test paper", p.exam],
                                    ["case_study", "Case study", p.caseStudy],
                                  ] as const
                                ).map(([kind, label, lesson]) => (
                                  <span key={kind} className="inline-flex items-center gap-1">
                                    <span className="text-[10px] uppercase tracking-wide text-[#98A0A9]">{label}</span>
                                    {lesson ||
                                    (!locked &&
                                      kind !== "presentation" &&
                                      p.presentation &&
                                      p.presentation.status !== "error") ? (
                                      <ContentCell
                                        bookId={b.id}
                                        schoolId={schoolId}
                                        chapterNum={ch.num}
                                        kind={kind}
                                        lesson={lesson}
                                        part={p.n}
                                        trackViews={!!beta}
                                        bookLanguage={b.language}
                                        genLocked={locked}
                                      />
                                    ) : (
                                      <span
                                        className="text-[#C6CBC4]"
                                        title={locked ? undefined : "Generated with the kit — free once the lesson exists"}
                                      >
                                        —
                                      </span>
                                    )}
                                  </span>
                                ))}
                                {partAssignable.length > 0 && (
                                  <span className="ml-auto">
                                    <AssignModal
                                      label="Assign"
                                      generationIds={partAssignable}
                                      classes={classes}
                                    />
                                  </span>
                                )}
                              </div>
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
                    <p className="text-xs text-[#5B6470] mb-1">Revision papers</p>
                    {b.revisionPapers.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">{p.label}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {p.status === "done" ? (
                            <>
                              {p.doc && (
                                <a href={p.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ Download
                                </a>
                              )}
                              <AssignModal label="Assign" generationIds={[p.id]} classes={classes} />
                            </>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status] ?? ""}`}>
                              {p.status}
                              {p.status === "processing"
                                ? ` · ${jobStageLabel(p.progress, p.stage)}${
                                    etaLabel("exam_paper", p.progress, p.stage)
                                      ? ` · ${etaLabel("exam_paper", p.progress, p.stage)}`
                                      : ""
                                  }`
                                : ""}
                            </span>
                          )}
                          <DeleteLesson genId={p.id} artifactPaths={p.artifactPaths} />
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
                    <p className="text-xs text-[#5B6470] mb-1">Exams</p>
                    {b.exams.map((e) => (
                      <div key={e.id} className="flex items-start justify-between gap-4 py-1.5">
                        <span className="min-w-0 flex-1">
                          <span className="text-sm text-[#14181F] block truncate">{e.label}</span>
                          {e.coverage && (
                            <span className="block text-[10px] text-[#98A0A9] truncate" title={e.coverage}>
                              Covers: {e.coverage}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {e.status === "done" ? (
                            <>
                              {e.doc && (
                                <a href={e.doc} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ Exam paper
                                </a>
                              )}
                              {e.answerKey && (
                                <a href={e.answerKey} className="text-xs font-medium text-[#0C8175] hover:underline">
                                  ⬇ Answer key
                                </a>
                              )}
                            </>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[e.status] ?? ""}`}>
                              {e.status}
                              {e.status === "processing"
                                ? ` · ${jobStageLabel(e.progress, e.stage)}${
                                    etaLabel("exam", e.progress, e.stage)
                                      ? ` · ${etaLabel("exam", e.progress, e.stage)}`
                                      : ""
                                  }`
                                : ""}
                            </span>
                          )}
                          <DeleteLesson genId={e.id} artifactPaths={e.artifactPaths} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {b.otherLessons.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#EEF0EC]">
                    <p className="text-xs text-[#5B6470] mb-1">Other lessons</p>
                    {b.otherLessons.map((l) => (
                      <div key={l.id} className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">{l.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {l.status === "done" ? <ArtifactLinks lesson={l} /> : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                              {l.status}
                              {l.status === "processing" ? ` · ${jobStageLabel(l.progress, l.stage)}` : ""}
                            </span>
                          )}
                          <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
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
                    <p className="text-xs text-[#5B6470] mb-1">Generated as selected</p>
                    {b.batchLessons.map((l) => {
                      const ch = b.chapters.find((c) => String(c.num) === l.chapterRef);
                      return (
                        <div key={l.id} className="flex items-center justify-between gap-4 py-1">
                          <span className="text-sm text-[#14181F] flex-1 min-w-0 truncate">
                            <span className="text-[#98A0A9]">
                              {ch ? `${ch.num + 1}. ` : ""}
                            </span>
                            {ch?.title ?? l.title}
                            <span className="text-xs text-[#98A0A9]"> · {KIND_LABEL[l.kind] ?? l.kind}</span>
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            {l.status === "done" ? <ArtifactLinks lesson={l} /> : (
                              <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                                {l.status}
                                {l.status === "processing" ? ` · ${jobStageLabel(l.progress, l.stage)}` : ""}
                              </span>
                            )}
                            <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
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
