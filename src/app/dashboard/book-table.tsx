"use client";

import { useState } from "react";
import GenerateButton from "./generate-button";
import GenerateAllButton from "./generate-all-button";
import DeleteBook from "./delete-book";
import DeleteLesson from "./delete-lesson";
import ContentCell, { type CellLesson } from "./content-cell";
import AssignModal, { type ClassRow } from "./assign-modal";

export type Lesson = CellLesson & { title: string; kind: string };
export type ChapterRow = {
  num: number;
  title: string;
  presentation: CellLesson | null;
  lessonPlan: CellLesson | null;
  activity: CellLesson | null;
  exam: CellLesson | null;
};
export type BookRow = {
  id: string;
  title: string;
  author: string | null;
  status: string | null;
  grade: string | null;
  subject: string | null;
  storagePath: string | null;
  createdAt: string;
  doneChapters: number;
  totalChapters: number;
  presentationIds: string[];
  chapters: ChapterRow[];
  pendingChapters: { num: number; title: string }[];
  otherLessons: (CellLesson & { title: string })[];
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#F1ECE0] text-[#6F6A5F]",
  processing: "bg-[#FAEEDA] text-[#854F0B]",
  done: "bg-[#EAF1EC] text-[#2E6B4E]",
  error: "bg-[#FCEBEB] text-[#A32D2D]",
};

const TYPE_LABEL = "text-[10px] uppercase tracking-wide text-[#9A958A]";

export default function BookTable({
  books,
  schoolId,
  classes,
}: {
  books: BookRow[];
  schoolId: string | null;
  classes: ClassRow[];
}) {
  // Expand the only book by default; otherwise everything starts collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    books.length === 1 ? { [books[0].id]: true } : {},
  );
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <div className="bg-white rounded-xl border border-[#EBE3D3] overflow-hidden">
      {books.map((b) => {
        const isOpen = !!open[b.id];
        const ready = b.status === "ready";
        return (
          <div key={b.id} className="border-b border-[#F1ECE0] last:border-b-0">
            <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-3 items-center">
              <button
                onClick={() => ready && toggle(b.id)}
                disabled={!ready}
                className="flex items-center gap-2 min-w-0 text-left disabled:cursor-default"
              >
                <span className={`text-[#9A958A] text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>
                  {ready ? "▶" : "•"}
                </span>
                <span className="min-w-0">
                  <span className="font-medium truncate block" style={{ fontFamily: "Georgia, serif" }}>
                    {b.title}
                  </span>
                  <span className="text-xs text-[#6F6A5F]">{b.author || "Unknown author"}</span>
                </span>
              </button>
              <span className="text-sm text-[#6F6A5F] text-right whitespace-nowrap self-center">
                {b.status === "indexing" ? (
                  "Finding chapters…"
                ) : b.status === "error" ? (
                  "—"
                ) : (
                  <>
                    <span
                      className={
                        b.doneChapters === b.totalChapters && b.totalChapters > 0
                          ? "text-[#2E6B4E] font-medium"
                          : "text-[#2C2A26] font-medium"
                      }
                    >
                      {b.doneChapters}/{b.totalChapters}
                    </span>{" "}
                    chapters
                  </>
                )}
              </span>
              <div className="flex items-center gap-2 whitespace-nowrap self-center">
                {ready && b.totalChapters > 0 && b.doneChapters === b.totalChapters && (
                  <AssignModal
                    label="Assign book"
                    generationIds={b.presentationIds}
                    classes={classes}
                  />
                )}
                <span className="text-xs text-[#6F6A5F]">
                  {new Date(b.createdAt).toLocaleDateString()}
                </span>
                <DeleteBook bookId={b.id} storagePath={b.storagePath} />
              </div>
            </div>

            {b.status === "error" && (
              <div className="px-5 pb-3 flex items-center gap-3">
                <span className="text-xs text-[#A32D2D]">Couldn&apos;t detect chapters.</span>
                <GenerateButton bookId={b.id} schoolId={schoolId} label="Generate full book" />
              </div>
            )}

            {isOpen && ready && (
              <div className="px-5 pb-4 bg-[#FCFAF4]">
                {b.pendingChapters.length > 0 && (
                  <div className="flex justify-end py-2">
                    <GenerateAllButton bookId={b.id} schoolId={schoolId} chapters={b.pendingChapters} />
                  </div>
                )}
                <ul className="border-t border-[#F1ECE0] divide-y divide-[#F1ECE0]">
                  {b.chapters.map((ch) => (
                    <li key={ch.num} className="py-2.5">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm text-[#2C2A26] flex-1 min-w-0 truncate">
                          <span className="text-[#9A958A]">{ch.num + 1}.</span> {ch.title}
                        </span>
                        <div className="shrink-0 flex items-center gap-2">
                          <span className={TYPE_LABEL}>Lesson</span>
                          <ContentCell bookId={b.id} schoolId={schoolId} chapterNum={ch.num} kind="presentation" lesson={ch.presentation} />
                          {ch.presentation?.status === "done" && (
                            <AssignModal
                              label="Assign"
                              generationIds={[ch.presentation.id]}
                              classes={classes}
                            />
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-1.5 pl-5">
                        <span className="flex items-center gap-2">
                          <span className={TYPE_LABEL}>Plan</span>
                          <ContentCell bookId={b.id} schoolId={schoolId} chapterNum={ch.num} kind="lesson_plan" lesson={ch.lessonPlan} />
                        </span>
                        <span className="flex items-center gap-2">
                          <span className={TYPE_LABEL}>Activities</span>
                          <ContentCell bookId={b.id} schoolId={schoolId} chapterNum={ch.num} kind="activity" lesson={ch.activity} />
                        </span>
                        <span className="flex items-center gap-2">
                          <span className={TYPE_LABEL}>Exam</span>
                          <ContentCell bookId={b.id} schoolId={schoolId} chapterNum={ch.num} kind="exam_paper" lesson={ch.exam} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>

                {b.otherLessons.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#F1ECE0]">
                    <p className="text-xs text-[#6F6A5F] mb-1">Other lessons</p>
                    {b.otherLessons.map((l) => (
                      <div key={l.id} className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm text-[#2C2A26] flex-1 min-w-0 truncate">{l.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {l.status === "done" ? (
                            <>
                              {l.video && (
                                <a href={l.video} target="_blank" className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                  ▶ Watch
                                </a>
                              )}
                              {l.deck && (
                                <a href={l.deck} className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                  ⬇ Deck
                                </a>
                              )}
                              {l.doc && (
                                <a href={l.doc} className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                  ⬇ Download
                                </a>
                              )}
                            </>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                              {l.status}
                              {l.status === "processing" ? ` · ${l.progress}%` : ""}
                            </span>
                          )}
                          <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
                        </div>
                      </div>
                    ))}
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
