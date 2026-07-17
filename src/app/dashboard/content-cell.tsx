"use client";

import GenerateButton from "./generate-button";
import RegenerateButton from "./regenerate-button";
import OptionsModal from "./options-modal";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";

export type CellLesson = {
  id: string;
  status: string;
  progress: number;
  video: string | null;
  /** All video parts in order — a long chapter renders as Part 1..N (~15 min each). */
  videos?: string[];
  deck: string | null;
  /** One deck per video part, same order. */
  decks?: string[];
  doc: string | null;
  params: Record<string, unknown> | null;
  artifactPaths: string[];
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#EEF0EC] text-[#5B6470]",
  processing: "bg-[#FFF1D6] text-[#9A6400]",
  error: "bg-[#FCEBEA] text-[#B42318]",
};

// One content type for a chapter: presentation (deck+video) or a .docx kind
// (lesson_plan / activity / exam_paper). The parent renders the type label.
export default function ContentCell({
  bookId,
  schoolId,
  chapterNum,
  kind,
  lesson,
  trackViews = false,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  kind: string;
  lesson: CellLesson | null;
  trackViews?: boolean; // beta: record artifact-opened events (feedback trigger)
}) {
  // Presentation generates directly; document kinds open a customization modal.
  const genControl = (label: string) =>
    kind === "presentation" ? (
      <GenerateButton
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        variant="ghost"
        label={label}
      />
    ) : (
      <OptionsModal
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        label={label}
      />
    );

  if (!lesson) return genControl("Generate");

  if (lesson.status === "queued" || lesson.status === "processing") {
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[lesson.status] ?? ""}`}>
        {lesson.status === "processing" ? `${lesson.progress}%` : "queued"}
      </span>
    );
  }

  if (lesson.status === "error") {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-[#B42318]">failed</span>
        {genControl("retry")}
        {/* Reporting moved to the page-bottom "Report a problem" widget — the
            inline per-artifact button cluttered every cell. */}
      </span>
    );
  }

  // done
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {kind === "presentation" ? (
        <>
          {(lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : []).map((url, i, all) => (
            <a
              key={i}
              href={url}
              target="_blank"
              onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")}
              className="font-medium text-[#0C8175] hover:underline"
            >
              {all.length > 1 ? (i === 0 ? "▶ Watch Pt 1" : `▶ Pt ${i + 1}`) : "▶ Watch"}
            </a>
          ))}
          {(lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : []).map((url, i, all) => (
            <a
              key={`d${i}`}
              href={url}
              onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")}
              className="font-medium text-[#0C8175] hover:underline"
            >
              {all.length > 1 ? `⬇ Deck Pt ${i + 1}` : "⬇ Deck"}
            </a>
          ))}
        </>
      ) : (
        lesson.doc && (
          <a
            href={lesson.doc}
            onClick={() => trackViews && recordArtifactView(lesson.id, "docx")}
            className="font-medium text-[#0C8175] hover:underline"
          >
            ⬇ Download
          </a>
        )
      )}
      {kind === "presentation" && (
        <AskCoachButton
          generationId={lesson.id}
          chapterLabel={`Chapter ${chapterNum + 1}`}
          className="font-medium text-[#0C8175] hover:underline"
        />
      )}
      <RegenerateButton
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        params={lesson.params}
        oldGenId={lesson.id}
        oldArtifactPaths={lesson.artifactPaths}
      />
      <DeleteLesson genId={lesson.id} artifactPaths={lesson.artifactPaths} />
    </span>
  );
}
