"use client";

import { useState } from "react";
import GenerateButton from "./generate-button";
import GenerateAllButton from "./generate-all-button";
import RegenerateButton from "./regenerate-button";
import DeleteBook from "./delete-book";
import DeleteLesson from "./delete-lesson";

export type Lesson = {
  id: string;
  status: string;
  progress: number;
  video: string | null;
  deck: string | null;
  artifactPaths: string[];
};
export type ChapterRow = { num: number; title: string; lesson: Lesson | null };
export type BookRow = {
  id: string;
  title: string;
  author: string | null;
  status: string | null;
  storagePath: string | null;
  createdAt: string;
  chapters: ChapterRow[];
  pendingChapters: { num: number; title: string }[];
  otherLessons: (Lesson & { title: string })[];
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#F1ECE0] text-[#6F6A5F]",
  processing: "bg-[#FAEEDA] text-[#854F0B]",
  done: "bg-[#EAF1EC] text-[#2E6B4E]",
  error: "bg-[#FCEBEB] text-[#A32D2D]",
};

function ChapterActions({
  book,
  ch,
  schoolId,
}: {
  book: BookRow;
  ch: ChapterRow;
  schoolId: string | null;
}) {
  const l = ch.lesson;
  if (!l)
    return (
      <GenerateButton bookId={book.id} schoolId={schoolId} chapterRef={ch.num} label="Generate" />
    );
  if (l.status === "done")
    return (
      <div className="flex items-center gap-3">
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
        <RegenerateButton
          bookId={book.id}
          schoolId={schoolId}
          chapterRef={ch.num}
          oldGenId={l.id}
          oldArtifactPaths={l.artifactPaths}
        />
        <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
      </div>
    );
  if (l.status === "error")
    return (
      <div className="flex items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE.error}`}>error</span>
        <GenerateButton bookId={book.id} schoolId={schoolId} chapterRef={ch.num} label="Retry" />
        <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
      </div>
    );
  // queued / processing
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
      {l.status}
      {l.status === "processing" ? ` · ${l.progress}%` : ""}
    </span>
  );
}

export default function BookTable({
  books,
  schoolId,
}: {
  books: BookRow[];
  schoolId: string | null;
}) {
  // Expand the only book by default; otherwise everything starts collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    books.length === 1 ? { [books[0].id]: true } : {},
  );
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <div className="bg-white rounded-xl border border-[#EBE3D3] overflow-hidden">
      <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-2.5 text-xs font-medium text-[#6F6A5F] border-b border-[#EBE3D3] bg-[#FBF8F1]">
        <span>Book</span>
        <span className="text-right">Chapters</span>
        <span className="text-right">Added</span>
      </div>

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
                {b.status === "indexing"
                  ? "Finding chapters…"
                  : b.status === "error"
                    ? "—"
                    : `${b.chapters.length} chapters`}
              </span>
              <div className="flex items-center gap-2 whitespace-nowrap self-center">
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
                    <li key={ch.num} className="flex items-center justify-between gap-4 py-2">
                      <span className="text-sm text-[#2C2A26] flex-1 min-w-0 truncate">
                        <span className="text-[#9A958A]">{ch.num + 1}.</span> {ch.title}
                      </span>
                      <div className="shrink-0">
                        <ChapterActions book={b} ch={ch} schoolId={schoolId} />
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
