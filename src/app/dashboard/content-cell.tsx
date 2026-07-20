"use client";

import GenerateButton from "./generate-button";
import RegenerateButton from "./regenerate-button";
import OptionsModal from "./options-modal";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";
import { jobStageLabel, etaLabel, type JobStage } from "@/utils/job-stage";

export type CellLesson = {
  id: string;
  status: string;
  progress: number;
  /** Part-major generation stage (0053) — "part 2/4 · 35%" narration. */
  stage?: JobStage;
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
  part = null,
  bookLanguage = null,
  genLocked = false,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  kind: string;
  lesson: CellLesson | null;
  trackViews?: boolean; // beta: record artifact-opened events (feedback trigger)
  /** Generate/display ONE part of the chapter (per-part lesson units). */
  part?: number | null;
  /** Detected book language (0056) — preselects the doc-modal language. */
  bookLanguage?: string | null;
  /** Trial: this cell's unit is outside the pin — hide generate/retry/
      regenerate (the DB would reject them) but keep artifacts + delete. */
  genLocked?: boolean;
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
        params={part ? { part } : null}
      />
    ) : (
      <OptionsModal
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        label={label}
        part={part}
        bookLanguage={bookLanguage}
      />
    );

  if (!lesson) return genLocked ? <span className="text-[#C6CBC4]">—</span> : genControl("Generate");

  if (lesson.status === "queued" || lesson.status === "processing") {
    const eta = lesson.status === "processing" ? etaLabel(kind, lesson.progress, lesson.stage) : "";
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[lesson.status] ?? ""}`}>
        {lesson.status === "processing"
          ? `${jobStageLabel(lesson.progress, lesson.stage)}${eta ? ` · ${eta}` : ""}`
          : "queued"}
      </span>
    );
  }

  if (lesson.status === "error") {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-[#B42318]">failed</span>
        {!genLocked && genControl("retry")}
        {/* Reporting moved to the page-bottom "Report a problem" widget — the
            inline per-artifact button cluttered every cell. */}
      </span>
    );
  }

  // done — multi-part lessons stack ONE LINE PER PART ("Part 2 · Watch · Deck")
  // instead of a single crowded row of Pt links.
  const videos = lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : [];
  const decks = lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : [];
  const nParts = Math.max(videos.length, decks.length);
  return (
    <span className={`inline-flex ${kind === "presentation" && nParts > 1 ? "items-start" : "items-center"} gap-2 text-xs`}>
      {kind === "presentation" ? (
        nParts > 1 ? (
          <span className="flex flex-col gap-0.5">
            {Array.from({ length: nParts }, (_, i) => (
              <span key={i} className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-[#5B6470] w-11">Part {i + 1}</span>
                {videos[i] && (
                  <a
                    href={videos[i]}
                    target="_blank"
                    onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")}
                    className="font-medium text-[#0C8175] hover:underline"
                  >
                    ▶ Watch
                  </a>
                )}
                {decks[i] && (
                  <a
                    href={decks[i]}
                    onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")}
                    className="font-medium text-[#0C8175] hover:underline"
                  >
                    ⬇ Deck
                  </a>
                )}
              </span>
            ))}
          </span>
        ) : (
          <>
            {videos[0] && (
              <a
                href={videos[0]}
                target="_blank"
                onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")}
                className="font-medium text-[#0C8175] hover:underline"
              >
                ▶ Watch
              </a>
            )}
            {decks[0] && (
              <a
                href={decks[0]}
                onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")}
                className="font-medium text-[#0C8175] hover:underline"
              >
                ⬇ Deck
              </a>
            )}
          </>
        )
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
      {!genLocked && (
        <RegenerateButton
          bookId={bookId}
          schoolId={schoolId}
          chapterRef={chapterNum}
          kind={kind}
          params={lesson.params}
          oldGenId={lesson.id}
          oldArtifactPaths={lesson.artifactPaths}
        />
      )}
      <DeleteLesson genId={lesson.id} artifactPaths={lesson.artifactPaths} />
    </span>
  );
}
