"use client";

import GenerateButton from "./generate-button";
import RegenerateButton from "./regenerate-button";
import OptionsModal from "./options-modal";
import DeleteLesson from "./delete-lesson";

export type CellLesson = {
  id: string;
  status: string;
  progress: number;
  video: string | null;
  deck: string | null;
  doc: string | null;
  params: Record<string, unknown> | null;
  artifactPaths: string[];
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#F1ECE0] text-[#6F6A5F]",
  processing: "bg-[#FAEEDA] text-[#854F0B]",
  error: "bg-[#FCEBEB] text-[#A32D2D]",
};

// One content type for a chapter: presentation (deck+video) or a .docx kind
// (lesson_plan / activity / exam_paper). The parent renders the type label.
export default function ContentCell({
  bookId,
  schoolId,
  chapterNum,
  kind,
  lesson,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  kind: string;
  lesson: CellLesson | null;
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
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-[#A32D2D]">failed</span>
        {genControl("retry")}
      </span>
    );
  }

  // done
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {kind === "presentation" ? (
        <>
          {lesson.video && (
            <a href={lesson.video} target="_blank" className="font-medium text-[#2E6B4E] hover:underline">
              ▶ Watch
            </a>
          )}
          {lesson.deck && (
            <a href={lesson.deck} className="font-medium text-[#2E6B4E] hover:underline">
              ⬇ Deck
            </a>
          )}
        </>
      ) : (
        lesson.doc && (
          <a href={lesson.doc} className="font-medium text-[#2E6B4E] hover:underline">
            ⬇ Download
          </a>
        )
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
