"use client";

import GenerateButton from "./generate-button";
import RegenerateButton from "./regenerate-button";
import OptionsModal from "./options-modal";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";
import { etaLabel, type JobStage } from "@/utils/job-stage";

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

// Icon-forward kit cells (2026-07-20): the icon IS the download/watch (no
// "Download" word); the label is the link text; ↻ regenerate + ✕ delete (delete
// on hover) sit beside it; progress shows as a compact ring, not a bar.
function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="inline-block align-[-1px] shrink-0" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-1px] shrink-0" aria-hidden>
      <path d="M12 3v12m0 0l4-4m-4 4l-4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}
function Ring({ pct }: { pct: number }) {
  const size = 14;
  const stroke = 2.2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="inline-block align-[-2px] shrink-0" style={{ transform: "rotate(-90deg)" }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E6E8E4" strokeWidth={stroke} />
      {pct > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#1FB8A6"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)}
        />
      )}
    </svg>
  );
}

// One content type for a chapter/part: presentation (video + deck) or a .docx
// kind. The label ("Plan", "Worksheet"…) is now the link text; presentation
// shows "Watch" + "Deck" instead.
export default function ContentCell({
  bookId,
  schoolId,
  chapterNum,
  kind,
  lesson,
  label = "",
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
  /** Display name — the link text (docs). Presentation ignores it (Watch/Deck). */
  label?: string;
  trackViews?: boolean; // beta: record artifact-opened events (feedback trigger)
  /** Generate/display ONE part of the chapter (per-part lesson units). */
  part?: number | null;
  /** Detected book language (0056) — preselects the doc-modal language. */
  bookLanguage?: string | null;
  /** Trial: this cell's unit is outside the pin — hide generate/retry/
      regenerate (the DB would reject them) but keep artifacts + delete. */
  genLocked?: boolean;
}) {
  const isPres = kind === "presentation";

  // Presentation generates directly; document kinds open a customization modal.
  const genControl = (lbl: string) =>
    isPres ? (
      <GenerateButton
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        variant="ghost"
        label={lbl}
        params={part ? { part } : null}
      />
    ) : (
      <OptionsModal
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        label={lbl}
        part={part}
        bookLanguage={bookLanguage}
      />
    );

  // Not generated: a free add-back once its lesson exists ("+ Worksheet"), or a
  // dash when the trial pin locks this unit.
  if (!lesson) return genLocked ? <span className="text-[#C6CBC4]">—</span> : genControl(`+ ${label}`);

  if (lesson.status === "queued" || lesson.status === "processing") {
    const eta = lesson.status === "processing" ? etaLabel(kind, lesson.progress, lesson.stage) : "";
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-[#98A0A9] whitespace-nowrap"
        title={`${label || "Lesson"} — ${lesson.status}${eta ? ` (${eta})` : ""}`}
      >
        {isPres ? (
          <>
            <PlayIcon /> Watch
          </>
        ) : (
          label
        )}
        <Ring pct={lesson.status === "processing" ? lesson.progress : 0} />
        {isPres && lesson.status === "processing" && (
          <span className="text-[#9A6400] tabular-nums">
            {lesson.progress}%{eta ? ` · ${eta}` : ""}
          </span>
        )}
      </span>
    );
  }

  if (lesson.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
        <span className="text-[#B42318]">{isPres ? "Watch" : label} failed</span>
        {!genLocked && genControl("retry")}
      </span>
    );
  }

  // done — multi-video presentations stack one line per part ("Pt 2 · Watch · Deck").
  const videos = lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : [];
  const decks = lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : [];
  const nParts = Math.max(videos.length, decks.length);
  const linkCls = "inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline";
  return (
    <span className={`group inline-flex ${isPres && nParts > 1 ? "items-start" : "items-center"} gap-1.5 text-xs whitespace-nowrap`}>
      {isPres ? (
        nParts > 1 ? (
          <span className="inline-flex flex-col gap-0.5">
            {Array.from({ length: nParts }, (_, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                <span className="text-[#98A0A9] w-8">Pt {i + 1}</span>
                {videos[i] && (
                  <a href={videos[i]} target="_blank" onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")} className={linkCls}>
                    <span className="text-[#1FB8A6]"><PlayIcon /></span>Watch
                  </a>
                )}
                {decks[i] && (
                  <a href={decks[i]} onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")} className={linkCls}>
                    <span className="text-[#1FB8A6]"><DownloadIcon /></span>Deck
                  </a>
                )}
              </span>
            ))}
          </span>
        ) : (
          <>
            {videos[0] && (
              <a href={videos[0]} target="_blank" onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")} className={linkCls}>
                <span className="text-[#1FB8A6]"><PlayIcon /></span>Watch
              </a>
            )}
            {decks[0] && (
              <a href={decks[0]} onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")} className={linkCls}>
                <span className="text-[#1FB8A6]"><DownloadIcon /></span>Deck
              </a>
            )}
          </>
        )
      ) : (
        lesson.doc && (
          <a href={lesson.doc} onClick={() => trackViews && recordArtifactView(lesson.id, "docx")} className={linkCls}>
            <span className="text-[#1FB8A6]"><DownloadIcon /></span>{label}
          </a>
        )
      )}
      {isPres && (
        <AskCoachButton generationId={lesson.id} chapterLabel={`Chapter ${chapterNum + 1}`} className="font-medium text-[#0C8175] hover:underline" />
      )}
      {!genLocked && (
        <RegenerateButton
          icon
          bookId={bookId}
          schoolId={schoolId}
          chapterRef={chapterNum}
          kind={kind}
          params={lesson.params}
          oldGenId={lesson.id}
          oldArtifactPaths={lesson.artifactPaths}
        />
      )}
      <DeleteLesson genId={lesson.id} artifactPaths={lesson.artifactPaths} className="hidden group-hover:inline-flex" />
    </span>
  );
}
