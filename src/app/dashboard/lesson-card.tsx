"use client";

import ContentCell, { kindLabel, type CellLesson, type LibraryMessages } from "./content-cell";
import AssignModal, { type ClassRow } from "./assign-modal";
import GenerateKitButton from "./generate-kit-button";
import RegenerateButton from "./regenerate-button";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";
import { etaLabel } from "@/utils/job-stage";
import { fmt } from "@/i18n/format";

// Preview-first lesson card (2026-07-21): a part's kit shown as a card — a deck
// preview with a play affordance, the lesson's real title, and its documents as
// chips — instead of a row of underlined links. The video "Watch" is the
// thumbnail; every document reuses ContentCell (so all of its state logic —
// progress rings, add-backs, retries, regenerate, delete — is preserved), just
// wrapped in a chip. Ungenerated parts show a single "Generate kit" card.

export type CardPart = {
  n: number;
  titles: string[];
  presentation: CellLesson | null;
  lessonPlan: CellLesson | null;
  activity: CellLesson | null;
  worksheet: CellLesson | null;
  exam: CellLesson | null;
  caseStudy: CellLesson | null;
};

// Document kinds shown as chips (the presentation is the thumbnail, not a chip).
// Second element is the matching CardPart field; the chip's wording comes from
// the dictionary via kindLabel(), keyed by the kind itself.
const DOCS = [
  ["lesson_plan", "lessonPlan"],
  ["activity", "activity"],
  ["worksheet", "worksheet"],
  ["exam_paper", "exam"],
  ["case_study", "caseStudy"],
] as const;

function PlayGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function DownloadGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-1px] shrink-0" aria-hidden>
      <path d="M12 3v12m0 0l4-4m-4 4l-4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}
function Ring({ pct, size = 22 }: { pct: number; size?: number }) {
  const stroke = 2.6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E6E8E4" strokeWidth={stroke} />
      {pct > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1FB8A6" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)} />
      )}
    </svg>
  );
}

// A mini "deck slide" drawn in CSS — echoes compose_slide (teal number badge +
// heading + a figure block). We have no rendered poster yet, so this stands in as
// the preview; when the video is ready its play button opens it.
function SlideThumb({ n, title, video, processing, pct, trackId, watchHint }: {
  n: number; title: string; video?: string | null; processing?: boolean; pct?: number; trackId?: string | null;
  watchHint: string;
}) {
  const slide = (
    <div className="absolute inset-0 rounded-lg bg-white border border-[#DCE6E2] overflow-hidden">
      <span className="absolute top-2 start-2 flex h-4 w-4 items-center justify-center rounded-full bg-[#1FB8A6] text-[10px] font-medium text-[#04342C]">{n}</span>
      <span className="absolute top-2.5 start-7 end-2 text-[8px] font-medium text-[#14181F] truncate">{title}</span>
      <span className="absolute top-[19px] start-7 h-[3px] w-8 rounded-full bg-[#E2F4F1]" />
      <span className="absolute bottom-2.5 end-3 h-7 w-9 rounded-md border-2 border-[#1FB8A6] bg-[#F4FBF9]" />
      <span className="absolute bottom-3.5 start-3 h-[3px] w-9 rounded-full bg-[#EEF0EC]" />
      <span className="absolute bottom-2.5 start-3 h-[3px] w-6 rounded-full bg-[#EEF0EC]" />
    </div>
  );
  const overlay = processing ? (
    <div className="absolute inset-0 flex items-center justify-center bg-white/45">
      <Ring pct={pct ?? 0} />
    </div>
  ) : video ? (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* pl-, not ps-: the triangle is a media TRANSPORT control, so it points
          right in every locale, and the optical nudge that centres it has to
          stay on the same physical side. */}
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#14181F]/60 text-white pl-0.5"><PlayGlyph /></span>
    </div>
  ) : null;
  const body = <div className="relative h-[74px] w-[128px] shrink-0">{slide}{overlay}</div>;
  return video && !processing ? (
    <a href={video} target="_blank" onClick={() => trackId && recordArtifactView(trackId, "video_mp4")} className="block hover:opacity-95" title={watchHint}>
      {body}
    </a>
  ) : body;
}

// One document artifact as a chip — ContentCell does the real work (states,
// add-back, retry, regenerate, delete); the pill is just its frame.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#DCE6E2] bg-white px-2.5 py-1 leading-none">
      {children}
    </span>
  );
}

export default function LessonCard({
  bookId,
  schoolId,
  chapterNum,
  part,
  classes,
  t,
  chapterTitle = "",
  bookTitle = null,
  locked = false,
  trackViews = false,
  bookLanguage = null,
  bookGrade = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  part: CardPart;
  classes: ClassRow[];
  t: LibraryMessages;
  /** Used to suppress a part title that just repeats the chapter heading. */
  chapterTitle?: string;
  /** Named in the failure report a teacher emails to staff. */
  bookTitle?: string | null;
  locked?: boolean;
  trackViews?: boolean;
  bookLanguage?: string | null;
  bookGrade?: string | null;
}) {
  const pres = part.presentation;
  const generated = !!pres && pres.status !== "error";
  const partLabel = fmt(t.part, { n: part.n });
  // Section titles come from the book's part map and aren't always usable as a
  // heading: some are bare numbering ("1", "1.2"), and a single-section part
  // often just repeats the chapter name, which would echo the heading above it.
  // Drop both, then fall back to "Part N" rather than showing a stray digit.
  const chapter = (chapterTitle || "").trim().toLowerCase();
  const titles = part.titles
    .map((s) => (s || "").trim())
    .filter((s) => s && !/^[\d.)\s-]+$/.test(s) && s.toLowerCase() !== chapter);
  const title = titles[0] || partLabel;
  const rest = titles.slice(1).join(" · ");
  const subtitle = rest || (title === partLabel ? "" : partLabel);

  // Trial (0057): this part isn't the pinned unit — a muted, non-actionable card.
  if (locked) {
    return (
      <div className="flex items-center gap-3.5 rounded-xl border border-dashed border-[#DCE6E2] bg-[#E1E8E5] px-3.5 py-3">
        <div className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#DCE6E2] bg-[#D8E1DD] flex items-center justify-center text-[#C6CBC4]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[#5B6470] truncate">{title}</div>
          <div className="text-xs text-[#98A0A9]">{fmt(t.card.trialOnePart, { part: partLabel })}</div>
        </div>
      </div>
    );
  }

  // Not generated: one clear card with a single "Generate kit" action.
  if (!generated) {
    return (
      // The WHOLE card is the button — a part that doesn't exist yet has exactly
      // one thing to do, so the click target is the card, not a link at its edge.
      <GenerateKitButton
        bookId={bookId}
        schoolId={schoolId}
        chapterNum={chapterNum}
        part={part.n}
        language={bookLanguage}
        bookGrade={bookGrade}
        className="group/new w-full text-start flex items-center gap-3.5 rounded-xl border border-dashed border-[#C3D0CB] bg-[#E1E8E5] px-3.5 py-3 transition-colors hover:bg-[#E9EFEC] hover:border-[#1FB8A6] disabled:opacity-70"
        skipKinds={(
          [
            ["lesson_plan", part.lessonPlan],
            ["activity", part.activity],
            ["worksheet", part.worksheet],
            ["exam_paper", part.exam],
            ["case_study", part.caseStudy],
          ] as const
        )
          .filter(([, l]) => l && l.status !== "error")
          .map(([k]) => k)}
      >
        {({ busy }) => (
          <>
            <span className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#C3D0CB] bg-[#D8E1DD] flex items-center justify-center text-[#B7C1B9] transition-colors group-hover/new:border-[#1FB8A6] group-hover/new:text-[#0C8175]">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </span>
            <span className="min-w-0 flex-1">
              {/* Ink is dialled back on the filled card so a made lesson (white,
                  full-contrast) still wins the eye. */}
              <span className="block text-sm font-medium text-[#556059] truncate">{title}</span>
              {/* Don't repeat the heading: when the title already fell back to
                  "Part N", the meta line drops it. */}
              <span className="block text-xs text-[#87938D] truncate">
                {subtitle ? `${subtitle} · ` : ""}{t.card.notGenerated}
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-medium text-[#0C8175]">
              {busy ? t.queuing : t.card.generateKit}
            </span>
          </>
        )}
      </GenerateKitButton>
    );
  }

  // Generated. Presentation states drive the thumbnail; documents are chips.
  const p = pres!;
  const processing = p.status === "queued" || p.status === "processing";
  const videos = p.videos?.length ? p.videos : p.video ? [p.video] : [];
  const decks = p.decks?.length ? p.decks : p.deck ? [p.deck] : [];
  const multi = Math.max(videos.length, decks.length) > 1;
  const eta =
    p.status === "processing" ? etaLabel("presentation", p.progress, p.stage, t.utils.job) : "";

  const assignable = [part.presentation, part.worksheet, part.exam]
    .filter((l): l is CellLesson => !!l && l.status === "done")
    .map((l) => l.id);

  return (
    <div className="group/card flex gap-3.5 rounded-xl border border-[#DCE6E2] bg-white px-3.5 py-3">
      <SlideThumb
        n={part.n}
        title={title}
        video={!processing && !multi ? videos[0] : null}
        processing={processing}
        pct={p.progress}
        trackId={trackViews ? p.id : null}
        watchHint={t.card.watchLesson}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate" title={titles.join(" · ")}>{title}</div>
            <div className="text-xs text-[#98A0A9] truncate">
              {subtitle}
              {processing && (
                <span className="text-[#9A6400]">
                  {subtitle ? " · " : ""}
                  {fmt(t.utils.job.percent, { pct: p.progress })}
                  {eta ? ` · ${eta}` : ""}
                </span>
              )}
            </div>
          </div>
          {/* Lesson-level controls: regenerate + delete (delete on hover). */}
          <span className="flex items-center gap-1 shrink-0">
            <RegenerateButton
              icon
              bookId={bookId}
              schoolId={schoolId}
              chapterRef={chapterNum}
              kind="presentation"
              params={p.params}
              oldGenId={p.id}
              oldArtifactPaths={p.artifactPaths}
            />
            <DeleteLesson genId={p.id} artifactPaths={p.artifactPaths} t={t} className="opacity-0 group-hover/card:opacity-100 transition-opacity" />
          </span>
        </div>

        {/* Artifact chips: Deck + Ask Coach + the five documents. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
          {multi ? (
            // Long lesson: one Watch·Deck chip per rendered part.
            Array.from({ length: Math.max(videos.length, decks.length) }, (_, i) => (
              <Chip key={i}>
                <span className="text-[#98A0A9] me-1.5">{fmt(t.partShort, { n: i + 1 })}</span>
                {videos[i] && (
                  <a href={videos[i]} target="_blank" onClick={() => trackViews && recordArtifactView(p.id, "video_mp4")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                    <span className="text-[#1FB8A6]"><PlayGlyph size={12} /></span>{t.watch}
                  </a>
                )}
                {decks[i] && (
                  <a href={decks[i]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline ms-2">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>{t.deck}
                  </a>
                )}
              </Chip>
            ))
          ) : (
            decks[0] && (
              <Chip>
                <a href={decks[0]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                  <span className="text-[#1FB8A6]"><DownloadGlyph /></span>{t.deck}
                </a>
              </Chip>
            )
          )}

          {DOCS.map(([kind, field]) => {
            const lesson = part[field];
            return (
              <Chip key={kind}>
                <ContentCell
                  bookId={bookId}
                  schoolId={schoolId}
                  chapterNum={chapterNum}
                  kind={kind}
                  label={kindLabel(t, kind)}
                  lesson={lesson}
                  part={part.n}
                  trackViews={trackViews}
                  bookLanguage={bookLanguage}
                  bookTitle={bookTitle}
                  t={t}
                />
              </Chip>
            );
          })}

          <span className="inline-flex items-center">
            <AskCoachButton generationId={p.id} chapterLabel={fmt(t.chapter, { n: chapterNum + 1 })} className="font-medium text-[#0C8175] hover:underline px-1" />
          </span>

          {assignable.length > 0 && (
            <span className="ms-auto">
              <AssignModal label={t.assign} generationIds={assignable} classes={classes} t={t} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
