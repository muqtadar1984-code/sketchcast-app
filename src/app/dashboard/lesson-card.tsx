"use client";

import ContentCell, { type CellLesson } from "./content-cell";
import AssignModal, { type ClassRow } from "./assign-modal";
import GenerateKitButton from "./generate-kit-button";
import RegenerateButton from "./regenerate-button";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";
import { etaLabel } from "@/utils/job-stage";

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
// Third element is the matching CardPart field.
const DOCS = [
  ["lesson_plan", "Plan", "lessonPlan"],
  ["activity", "Activities", "activity"],
  ["worksheet", "Worksheet", "worksheet"],
  ["exam_paper", "Test paper", "exam"],
  ["case_study", "Case study", "caseStudy"],
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
function SlideThumb({ n, title, video, processing, pct, trackId }: {
  n: number; title: string; video?: string | null; processing?: boolean; pct?: number; trackId?: string | null;
}) {
  const slide = (
    <div className="absolute inset-0 rounded-lg bg-white border border-[#E6E8E4] overflow-hidden">
      <span className="absolute top-2 left-2 flex h-4 w-4 items-center justify-center rounded-full bg-[#1FB8A6] text-[10px] font-medium text-[#04342C]">{n}</span>
      <span className="absolute top-2.5 left-7 right-2 text-[8px] font-medium text-[#14181F] truncate">{title}</span>
      <span className="absolute top-[19px] left-7 h-[3px] w-8 rounded-full bg-[#E2F4F1]" />
      <span className="absolute bottom-2.5 right-3 h-7 w-9 rounded-md border-2 border-[#1FB8A6] bg-[#F4FBF9]" />
      <span className="absolute bottom-3.5 left-3 h-[3px] w-9 rounded-full bg-[#EEF0EC]" />
      <span className="absolute bottom-2.5 left-3 h-[3px] w-6 rounded-full bg-[#EEF0EC]" />
    </div>
  );
  const overlay = processing ? (
    <div className="absolute inset-0 flex items-center justify-center bg-white/45">
      <Ring pct={pct ?? 0} />
    </div>
  ) : video ? (
    <div className="absolute inset-0 flex items-center justify-center">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#14181F]/60 text-white pl-0.5"><PlayGlyph /></span>
    </div>
  ) : null;
  const body = <div className="relative h-[74px] w-[128px] shrink-0">{slide}{overlay}</div>;
  return video && !processing ? (
    <a href={video} target="_blank" onClick={() => trackId && recordArtifactView(trackId, "video_mp4")} className="block hover:opacity-95" title="Watch the lesson">
      {body}
    </a>
  ) : body;
}

// One document artifact as a chip — ContentCell does the real work (states,
// add-back, retry, regenerate, delete); the pill is just its frame.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#E6E8E4] bg-white px-2.5 py-1 leading-none">
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
  chapterTitle = "",
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
  /** Used to suppress a part title that just repeats the chapter heading. */
  chapterTitle?: string;
  locked?: boolean;
  trackViews?: boolean;
  bookLanguage?: string | null;
  bookGrade?: string | null;
}) {
  const pres = part.presentation;
  const generated = !!pres && pres.status !== "error";
  const partLabel = `Part ${part.n}`;
  // Section titles come from the book's part map and aren't always usable as a
  // heading: some are bare numbering ("1", "1.2"), and a single-section part
  // often just repeats the chapter name, which would echo the heading above it.
  // Drop both, then fall back to "Part N" rather than showing a stray digit.
  const chapter = (chapterTitle || "").trim().toLowerCase();
  const titles = part.titles
    .map((t) => (t || "").trim())
    .filter((t) => t && !/^[\d.)\s-]+$/.test(t) && t.toLowerCase() !== chapter);
  const title = titles[0] || partLabel;
  const rest = titles.slice(1).join(" · ");
  const subtitle = rest || (title === partLabel ? "" : partLabel);

  // Trial (0057): this part isn't the pinned unit — a muted, non-actionable card.
  if (locked) {
    return (
      <div className="flex items-center gap-3.5 rounded-xl border border-dashed border-[#E6E8E4] bg-[#FAFBF9] px-3.5 py-3">
        <div className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#E6E8E4] bg-white/60 flex items-center justify-center text-[#C6CBC4]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[#5B6470] truncate">{title}</div>
          <div className="text-xs text-[#98A0A9]">{partLabel} · your trial covers one part</div>
        </div>
      </div>
    );
  }

  // Not generated: one clear card with a single "Generate kit" action.
  if (!generated) {
    return (
      <div className="flex items-center gap-3.5 rounded-xl border border-dashed border-[#D6DAD3] bg-white px-3.5 py-3">
        <div className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#D6DAD3] bg-[#F5F6F3] flex items-center justify-center text-[#B7C1B9]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{title}</div>
          {subtitle ? (
            <div className="text-xs text-[#98A0A9] truncate">{subtitle}</div>
          ) : (
            <div className="text-xs text-[#98A0A9]">{partLabel} · not generated yet · 1 credit</div>
          )}
        </div>
        <GenerateKitButton
          bookId={bookId}
          schoolId={schoolId}
          chapterNum={chapterNum}
          part={part.n}
          language={bookLanguage}
          bookGrade={bookGrade}
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
        />
      </div>
    );
  }

  // Generated. Presentation states drive the thumbnail; documents are chips.
  const p = pres!;
  const processing = p.status === "queued" || p.status === "processing";
  const videos = p.videos?.length ? p.videos : p.video ? [p.video] : [];
  const decks = p.decks?.length ? p.decks : p.deck ? [p.deck] : [];
  const multi = Math.max(videos.length, decks.length) > 1;
  const eta = p.status === "processing" ? etaLabel("presentation", p.progress, p.stage) : "";

  const assignable = [part.presentation, part.worksheet, part.exam]
    .filter((l): l is CellLesson => !!l && l.status === "done")
    .map((l) => l.id);

  return (
    <div className="group/card flex gap-3.5 rounded-xl border border-[#EAECE7] bg-white px-3.5 py-3">
      <SlideThumb
        n={part.n}
        title={title}
        video={!processing && !multi ? videos[0] : null}
        processing={processing}
        pct={p.progress}
        trackId={trackViews ? p.id : null}
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
                  {p.progress}%{eta ? ` · ${eta}` : ""}
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
            <DeleteLesson genId={p.id} artifactPaths={p.artifactPaths} className="opacity-0 group-hover/card:opacity-100 transition-opacity" />
          </span>
        </div>

        {/* Artifact chips: Deck + Ask Coach + the five documents. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {multi ? (
            // Long lesson: one Watch·Deck chip per rendered part.
            Array.from({ length: Math.max(videos.length, decks.length) }, (_, i) => (
              <Chip key={i}>
                <span className="text-[#98A0A9] mr-1.5">Pt {i + 1}</span>
                {videos[i] && (
                  <a href={videos[i]} target="_blank" onClick={() => trackViews && recordArtifactView(p.id, "video_mp4")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                    <span className="text-[#1FB8A6]"><PlayGlyph size={12} /></span>Watch
                  </a>
                )}
                {decks[i] && (
                  <a href={decks[i]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline ml-2">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>Deck
                  </a>
                )}
              </Chip>
            ))
          ) : (
            decks[0] && (
              <Chip>
                <a href={decks[0]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                  <span className="text-[#1FB8A6]"><DownloadGlyph /></span>Deck
                </a>
              </Chip>
            )
          )}

          {DOCS.map(([kind, label, field]) => {
            const lesson = part[field];
            return (
              <Chip key={kind}>
                <ContentCell
                  bookId={bookId}
                  schoolId={schoolId}
                  chapterNum={chapterNum}
                  kind={kind}
                  label={label}
                  lesson={lesson}
                  part={part.n}
                  trackViews={trackViews}
                  bookLanguage={bookLanguage}
                />
              </Chip>
            );
          })}

          <span className="inline-flex items-center">
            <AskCoachButton generationId={p.id} chapterLabel={`Chapter ${chapterNum + 1}`} className="font-medium text-[#0C8175] hover:underline px-1" />
          </span>

          {assignable.length > 0 && (
            <span className="ml-auto">
              <AssignModal label="Assign" generationIds={assignable} classes={classes} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
