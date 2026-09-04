"use client";

import GenerateButton from "./generate-button";
import RegenerateButton from "./regenerate-button";
import OptionsModal from "./options-modal";
import { type JunkGateInfo } from "./junk-gate-dialog";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import ReportFailure from "./report-failure";
import { recordArtifactView } from "@/utils/views";
import { etaLabel, type JobStage } from "@/utils/job-stage";
import { fmt } from "@/i18n/format";
import { statusLabel, type LibraryMessages } from "./labels";

export type CellLesson = {
  id: string;
  status: string;
  progress: number;
  /** Part-major generation stage (0053) — "part 2/4 · 35%" narration. */
  stage?: JobStage;
  video: string | null;
  /** All video parts in order — a long chapter renders as Part 1..N (~15 min each). */
  videos?: string[];
  /** TEMPORARY (2026-08-31): download-dispositioned twins of `videos`, same
   *  order and indices (a slot may be null if that path failed to sign). Only
   *  signed for the accounts allow-listed in @/utils/video-download — empty for
   *  everyone else, so the Save link simply never renders. */
  videoDownloads?: (string | null)[];
  deck: string | null;
  /** One deck per video part, same order. */
  decks?: string[];
  doc: string | null;
  /** The separate answer-key / teacher-notes document (artifact kind
   *  'answer_key_docx'). Non-null once the student/teacher document split
   *  (2026-08-18) has run for this generation — legacy combined documents
   *  have none. Adult surfaces offer it beside the doc, clearly labeled;
   *  students never receive it (see the student gate in dashboard/page.tsx). */
  answerKey?: string | null;
  params: Record<string, unknown> | null;
  artifactPaths: string[];
};

// LibraryMessages, statusLabel and kindLabel moved to ./labels on 2026-09-03:
// this file is a Client Component, so a Server Component that imported a
// helper from it and CALLED it threw at render time (see labels.ts). The type
// is re-exported so the dozen cells, cards and modals that name it from here
// keep working — a type re-export is erased and carries no such hazard. The
// two functions are deliberately NOT re-exported: through this module they
// would reach a server importer as client references all over again.
export type { LibraryMessages } from "./labels";

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

// One content type for a chapter/part: presentation (video, plus a legacy
// deck on pre-0103 kits), the slide deck (.pptx, 0103) or a .docx kind. The
// label ("Deck", "Plan", "Worksheet"…) is now the link text; presentation
// shows "Watch" (+ "Deck" for a legacy kit) instead.
export default function ContentCell({
  bookId,
  schoolId,
  chapterNum,
  kind,
  lesson,
  t,
  label = "",
  trackViews = false,
  part = null,
  bookLanguage = null,
  genLocked = false,
  bookTitle = null,
  gate = null,
  hideDeck = false,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  kind: string;
  lesson: CellLesson | null;
  t: LibraryMessages;
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
  /** Named in the failure report emailed to staff; falls back to the book id. */
  bookTitle?: string | null;
  /** Junk-upload gate: non-null for a gated book — every generate/retry/
      regenerate this cell offers confirms first. */
  gate?: JunkGateInfo | null;
  /** The presentation cell of a unit that has a deck GENERATION (0103): hide
      the legacy deck link(s) riding on the presentation row, so the row does
      not offer the same deck twice. */
  hideDeck?: boolean;
}) {
  const isPres = kind === "presentation";
  // The slide deck (0103): its own generation, free with its lesson. It has
  // no options, so it generates directly like the presentation, and its one
  // artifact is the .pptx — rendered through the document branch below.
  const isDeck = kind === "deck";

  // Presentation and deck generate directly; document kinds open a
  // customization modal.
  const genControl = (lbl: string) =>
    isPres || isDeck ? (
      <GenerateButton
        bookId={bookId}
        schoolId={schoolId}
        chapterRef={chapterNum}
        kind={kind}
        variant="ghost"
        label={lbl}
        params={part ? { part } : null}
        gate={gate}
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
        gate={gate}
        t={t}
      />
    );

  // Not generated: a free add-back once its lesson exists ("+ Worksheet"), or a
  // dash when the trial pin locks this unit.
  if (!lesson) return genLocked ? <span className="text-[#C6CBC4]">—</span> : genControl(fmt(t.cell.addBack, { label }));

  if (lesson.status === "queued" || lesson.status === "processing") {
    const eta =
      lesson.status === "processing" ? etaLabel(kind, lesson.progress, lesson.stage, t.utils.job) : "";
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[13px] text-[#98A0A9] whitespace-nowrap"
        title={`${fmt(t.cell.statusTitle, {
          label: label || t.kinds.presentation,
          status: statusLabel(t, lesson.status),
        })}${eta ? ` (${eta})` : ""}`}
      >
        {isPres ? (
          <>
            <PlayIcon /> {t.watch}
          </>
        ) : (
          label
        )}
        <Ring pct={lesson.status === "processing" ? lesson.progress : 0} />
        {isPres && lesson.status === "processing" && (
          <span className="text-[#9A6400] tabular-nums">
            {fmt(t.utils.job.percent, { pct: lesson.progress })}
            {eta ? ` · ${eta}` : ""}
          </span>
        )}
      </span>
    );
  }

  if (lesson.status === "error") {
    // "retry" re-runs it as-is; "report" emails the SketchCast team the book,
    // chapter and part so someone can look at it. Offered ONLY where something
    // has actually failed — the per-artifact reporter was removed from every
    // artifact for being noisy, and this brings it back just where it earns place.
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap">
        <span className="text-[#B42318]">{fmt(t.cell.failed, { label: isPres ? t.watch : label })}</span>
        {!genLocked && genControl(t.cell.retry)}
        <ReportFailure
          generationId={lesson.id}
          kind={kind}
          label={isPres ? t.kinds.presentation : label}
          bookId={bookId}
          bookTitle={bookTitle}
          chapterNum={chapterNum}
          part={part}
        />
      </span>
    );
  }

  // done — multi-video presentations stack one chip per part ("Pt 2 · Watch · Deck").
  const videos = lesson.videos?.length ? lesson.videos : lesson.video ? [lesson.video] : [];
  // Legacy decks (built inside the presentation job, pre-0103) — suppressed
  // once the unit has a deck generation of its own.
  const decks = hideDeck ? [] : lesson.decks?.length ? lesson.decks : lesson.deck ? [lesson.deck] : [];
  // Document branch: the deck generation's artifact is its .pptx, the rest
  // download a .docx. Only the documents can carry a split answer key.
  const docHref = isDeck ? lesson.deck : lesson.doc;
  const docViewKind = isDeck ? "deck_pptx" : "docx";
  // TEMPORARY (2026-08-31): founder-only "Save" links, index-aligned with
  // `videos`. Empty for every other account, so nothing extra renders.
  const videoDownloads = lesson.videoDownloads ?? [];
  const nParts = Math.max(videos.length, decks.length);
  const linkCls = "inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline";
  return (
    <span className={`group inline-flex ${isPres && nParts > 1 ? "items-start" : "items-center"} gap-1.5 text-[13px] whitespace-nowrap`}>
      {isPres ? (
        nParts > 1 ? (
          <span className="inline-flex flex-col gap-1">
            {Array.from({ length: nParts }, (_, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-[#DCE6E2] bg-[#FCFCFA] px-2.5 py-1">
                <span className="text-[#98A0A9] w-8">{fmt(t.partShort, { n: i + 1 })}</span>
                {videos[i] && (
                  <a href={videos[i]} target="_blank" onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")} className={linkCls}>
                    <span className="text-[#1FB8A6]"><PlayIcon /></span>{t.watch}
                  </a>
                )}
                {/* TEMPORARY founder-only download. No target="_blank" (a
                    disposition download would strand an empty tab) and no
                    recordArtifactView — a save is not a view, and this must not
                    colour the analytics. The label is a plain English literal on
                    purpose: a dictionary key would have to land in all 10
                    locales, and this affordance is never shown to a customer. */}
                {videoDownloads[i] && (
                  <a href={videoDownloads[i]!} className={linkCls}>
                    <span className="text-[#1FB8A6]"><DownloadIcon /></span>Save
                  </a>
                )}
                {decks[i] && (
                  <a href={decks[i]} onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")} className={linkCls}>
                    <span className="text-[#1FB8A6]"><DownloadIcon /></span>{t.deck}
                  </a>
                )}
              </span>
            ))}
          </span>
        ) : (
          <>
            {videos[0] && (
              <a href={videos[0]} target="_blank" onClick={() => trackViews && recordArtifactView(lesson.id, "video_mp4")} className={linkCls}>
                <span className="text-[#1FB8A6]"><PlayIcon /></span>{t.watch}
              </a>
            )}
            {/* TEMPORARY founder-only download — see the multi-part branch. */}
            {videoDownloads[0] && (
              <a href={videoDownloads[0]!} className={linkCls}>
                <span className="text-[#1FB8A6]"><DownloadIcon /></span>Save
              </a>
            )}
            {decks[0] && (
              <a href={decks[0]} onClick={() => trackViews && recordArtifactView(lesson.id, "deck_pptx")} className={linkCls}>
                <span className="text-[#1FB8A6]"><DownloadIcon /></span>{t.deck}
              </a>
            )}
          </>
        )
      ) : (
        <>
          {docHref && (
            <a href={docHref} onClick={() => trackViews && recordArtifactView(lesson.id, docViewKind)} className={linkCls}>
              <span className="text-[#1FB8A6]"><DownloadIcon /></span>{label}
            </a>
          )}
          {/* The split key/teacher-notes document (2026-08-18) — adult-only
              surface, so it is always offered when it exists, labeled with the
              same dictionary key the exams section uses. */}
          {!isDeck && lesson.answerKey && (
            <a href={lesson.answerKey} onClick={() => trackViews && recordArtifactView(lesson.id, "answer_key_docx")} className={linkCls}>
              <span className="text-[#1FB8A6]"><DownloadIcon /></span>{t.book.answerKey}
            </a>
          )}
        </>
      )}
      {isPres && (
        <AskCoachButton generationId={lesson.id} chapterLabel={fmt(t.chapter, { n: chapterNum + 1 })} className="font-medium text-[#0C8175] hover:underline" />
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
          gate={gate}
        />
      )}
      {/* Only reachable in the done branch — queued/processing return above —
          but the status is passed anyway so the control decides for itself.

          NO hover reveal. This was `hidden group-hover:inline-flex`, measured
          as 15 of 15 delete controls rendering 0x0 at 375x812: `group-hover`
          never fires on a touch device, so the control did not exist on any
          phone. It is the same idiom that hid the scanner's manual-crop button
          and got reported as the app freezing (see page-scanner.tsx, which
          settled on "always visible" for exactly this reason). A little more
          ink on desktop is the price of a control that exists everywhere. */}
      <DeleteLesson genId={lesson.id} status={lesson.status} t={t} />
    </span>
  );
}
