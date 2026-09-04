"use client";

import { useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import QuizPlayer, { type StudentQuizData } from "./quiz-player";
import AskCoach from "./ask-coach";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// Pro+ AI tutor entry point on lessons. Client flag mirrors the server gate
// (FEATURE_AI_TUTOR); the /api/tutor route is authoritative regardless.
const AI_TUTOR = process.env.NEXT_PUBLIC_FEATURE_AI_TUTOR === "true";

export type ProgressStatus = "assigned" | "in_progress" | "completed" | "revised";

export type StudentItemData = {
  genId: string;
  kind: string;
  label: string;
  dueAt: string | null;
  dueOverdue: boolean;
  classId: string | null;
  video: string | null;
  /** All video parts in order (long chapters render as Part 1..N). A null slot
   * = that part's signed URL failed this render — the SLOT stays so part
   * numbering/progress math never shifts. */
  videos?: (string | null)[];
  deck: string | null;
  /** One deck per part, same order. */
  decks?: string[];
  doc: string | null;
  /** Route that serves the ANSWER-STRIPPED paper (/api/quiz/{genId}), or null
   * when this generation has no interactive quiz. Never a signed artifact URL:
   * questions.json carries the marking scheme and is service-role only. */
  quiz: string | null;
  status: ProgressStatus | null;
  revisionCount: number;
  /** Encodes per-part progress for multi-part lessons: part k of N done ⇒
   * floor(100·k/N). Single-part lessons use it as before. */
  progressPct: number;
  submitted: boolean;
};

/** Every word a row can render, composed server-side by the student dashboard
 * (its own `student` namespace plus the shared Close). Typed from the English
 * dictionary, but the import is type-only — the server-only module is erased
 * here and no translation file reaches the browser bundle. */
export type StudentItemMessages = Dictionary["student"] & { close: string };

function Badge({
  status,
  submitted,
  t,
}: {
  status: ProgressStatus | null;
  submitted: boolean;
  t: StudentItemMessages["status"];
}) {
  if (status === "completed" || (submitted && status !== "revised"))
    return <span className="chip normal-case tracking-normal bg-[#E2F4F1] text-[#0C8175]">✓ {t.completed}</span>;
  if (status === "revised")
    return <span className="chip normal-case tracking-normal bg-[#FFF1D6] text-[#9A6400]">↻ {t.revised}</span>;
  if (status === "in_progress")
    return <span className="chip normal-case tracking-normal bg-[#EEF0EC] text-[#5B6470]">{t.inProgress}</span>;
  return <span className="chip normal-case tracking-normal bg-[#EEF0EC] text-[#98A0A9]">{t.notStarted}</span>;
}

// One assigned item on the student dashboard. The lesson plays in-app and is
// marked complete when watched to the end (re-opening a finished one -> revised);
// worksheets/exams are opened, then an answer file is uploaded to submit; the
// slide deck (kind 'deck', assignable since 2026-09-04) is downloaded, and that
// download is the whole task. All writes go through the student's own session
// (RLS).
//
// Its words arrive whole from the server (`t`) — the part counters read
// "Part {n} of {total}" from the file rather than being glued together here, so
// a language that counts in a different order still reads as a sentence.
export default function StudentItem({
  item,
  studentId,
  t,
  lang,
}: {
  item: StudentItemData;
  studentId: string;
  t: StudentItemMessages;
  /** BCP-47 tag for the due date. Passed explicitly rather than left to the
   * runtime default, which is the SERVER's locale during the prerender and the
   * BROWSER's after hydration — two different dates for the same row. */
  lang: string;
}) {
  const supabase = createClient();
  const [status, setStatus] = useState<ProgressStatus | null>(item.status);
  const [revisions, setRevisions] = useState(item.revisionCount);
  const [submitted, setSubmitted] = useState(item.submitted);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<StudentQuizData | null>(null);
  const [coaching, setCoaching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Long chapters arrive as several ~15-min parts — designed to be watched ONE
  // PART PER DAY in class (a 4-part chapter ≈ 4 days). Each finished part is
  // recorded (progress_pct encodes parts-done), so tomorrow resumes at the next
  // part; the lesson only counts complete after the LAST part.
  const parts: (string | null)[] = item.videos?.length ? item.videos : item.video ? [item.video] : [];
  const [partIdx, setPartIdx] = useState(0);
  // What just happened when a part finished — drives the between-parts screen
  // honestly (a replay or an out-of-order watch must not claim progress).
  const [endInfo, setEndInfo] = useState<null | { part: number; counted: boolean; completed: boolean }>(null);
  const initialDone =
    item.status === "completed" || item.status === "revised"
      ? parts.length
      : parts.length > 1
        ? Math.min(parts.length, Math.round((item.progressPct * parts.length) / 100))
        : 0;
  const [doneParts, setDoneParts] = useState(initialDone);
  // A revisit of a completed lesson counts as ONE revision per page visit —
  // not one per part chip clicked (that would inflate revision counts ~N×).
  const revisedOnceRef = useRef(false);
  const base = { generation_id: item.genId, student_id: studentId, class_id: item.classId };
  // submissions has NO class_id column (0006) — spreading `base` into it made
  // PostgREST reject EVERY submission (quiz and file alike) while the sr-only
  // error span hid the failure. Caught 2026-08-18 by the founder's homeschool
  // demo: every submissions row in prod was seed data; no real student had
  // ever submitted. student_progress keeps `base` — it has the column.
  const subBase = { generation_id: item.genId, student_id: studentId };

  async function markOpen() {
    if (status === "completed" || status === "revised") {
      if (revisedOnceRef.current) return; // one revision per visit, not per part
      revisedOnceRef.current = true;
      const next = revisions + 1;
      await supabase
        .from("student_progress")
        .upsert({ ...base, status: "revised", revised_at: new Date().toISOString(), revision_count: next }, { onConflict: "generation_id,student_id" });
      setRevisions(next);
      setStatus("revised");
    } else if (!status || status === "assigned") {
      await supabase
        .from("student_progress")
        .upsert({ ...base, status: "in_progress", opened_at: new Date().toISOString() }, { onConflict: "generation_id,student_id" });
      setStatus("in_progress");
    }
  }

  async function markComplete() {
    if (status === "completed" || status === "revised") return;
    await supabase
      .from("student_progress")
      .upsert({ ...base, status: "completed", completed_at: new Date().toISOString(), progress_pct: 100 }, { onConflict: "generation_id,student_id" });
    setStatus("completed");
  }

  /** Record "watched up to part k" without completing the lesson. */
  async function markPartDone(k: number) {
    await supabase.from("student_progress").upsert(
      {
        ...base,
        status: "in_progress",
        progress_pct: Math.floor((100 * k) / parts.length),
        opened_at: new Date().toISOString(),
      },
      { onConflict: "generation_id,student_id" },
    );
    if (!status || status === "assigned") setStatus("in_progress");
  }

  function watch(at?: number) {
    if (!parts.length) return;
    // Resume where the class left off: the first unwatched part; a fully
    // watched lesson REWATCHES from Part 1 (not the last part). Chips replay
    // any specific part.
    setPartIdx(at ?? (doneParts >= parts.length ? 0 : Math.min(doneParts, parts.length - 1)));
    setEndInfo(null);
    setPlaying(true);
    void markOpen();
  }

  function onPartEnded() {
    const k = partIdx + 1;
    const already = status === "completed" || status === "revised";
    // STRICTLY sequential: a part only counts when it's the NEXT one — jumping
    // straight to the last chip must not complete a 4-day lesson in one sitting
    // (replays of earlier parts record nothing, same as before).
    let counted = false;
    let completed = already;
    if (!already && k === doneParts + 1) {
      counted = true;
      if (k === parts.length) {
        completed = true;
        void markComplete();
      } else {
        void markPartDone(k);
      }
      setDoneParts(k);
    }
    // Multi-part: pause on the between-parts screen — one part per day is the
    // point, so the next part is a deliberate click, never an autoplay. The
    // screen shows on EVERY part end (including the last: that's the
    // congratulations moment) and words itself by what actually happened.
    if (parts.length > 1) setEndInfo({ part: k, counted, completed });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${studentId}/${item.genId}/${Date.now()}_${safe}`;
    const up = await supabase.storage.from("submissions").upload(path, f, { upsert: true });
    if (up.error) {
      setError(up.error.message);
      setBusy(false);
      return;
    }
    // Every mark-bearing column is written NULL on purpose, not left out.
    // Migration 0091 confines a student session to mode='file' rows that carry
    // no score at all (that is what stops a browser from authoring its own
    // grade), so an upsert that merely omitted teacher_score would keep the
    // OLD value on a resubmit and be rejected by the policy. Nulling them is
    // also the honest meaning of a resubmit: these are new answers, ungraded —
    // and `feedback` is in that list for the same reason. It is the TEACHER's
    // column (grade-list.tsx is its only other writer); the policy now pins it
    // to NULL here so a student cannot put words into it, and the words a
    // teacher wrote were about answers that no longer exist.
    // attempt_count is deliberately absent: it defaults to 0 on insert, keeps
    // its value on update, and 0091 pins it to 0 for a student write.
    const { error: sErr } = await supabase
      .from("submissions")
      .upsert(
        {
          ...subBase,
          mode: "file",
          file_path: path,
          answers: null,
          auto_score: null,
          max_score: null,
          teacher_score: null,
          feedback: null,
          graded_by: null,
          graded_at: null,
          grade_status: "pending",
          submitted_at: new Date().toISOString(),
        },
        { onConflict: "generation_id,student_id" },
      );
    if (sErr) {
      // 0091's UPDATE policy requires the EXISTING row to be mode='file', so a
      // student who already answered in-app cannot overwrite that submission
      // with a file (which would erase the score and the attempt count). That
      // refusal arrives as a bare 42501 "row-level security" string — useless
      // to a child. Name the actual situation instead; every other failure
      // still shows its own message.
      const denied = sErr.code === "42501" || /row-level security/i.test(sErr.message);
      setError(denied ? t.item.quizAlreadyAnswered : sErr.message);
      setBusy(false);
      return;
    }
    await markComplete();
    setSubmitted(true);
    setBusy(false);
  }

  // item.quiz is /api/quiz/{genId} — the answer-STRIPPED paper. It used to be a
  // service-role signed URL straight to questions.json, which a verifier could
  // fetch from production with no credentials and read the key out of.
  async function takeQuiz() {
    if (!item.quiz) return;
    setError(null);
    try {
      const res = await fetch(item.quiz);
      if (!res.ok) {
        setError(t.item.quizUnavailable);
        return;
      }
      const data = (await res.json()) as StudentQuizData;
      if (!data?.questions?.length) {
        setError(t.item.quizUnavailable);
        return;
      }
      setQuiz(data);
      void markOpen();
    } catch {
      setError(t.item.quizLoadFailed);
    }
  }

  // The score is the SERVER's answer, not the browser's: the route grades
  // against the key and writes the row with the service role. The response is
  // read for its error text only — nothing on this screen shows a mark.
  async function onQuizSubmit(answers: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch("/api/quiz/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: item.genId, answers }),
      });
    } catch {
      // Thrown so the quiz modal shows it inline and re-enables Submit —
      // a swallowed error here left the player stuck with no feedback.
      throw new Error("Couldn't submit — please try again.");
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(json?.error || "Couldn't submit — please try again.");
    }
    await markComplete();
    setSubmitted(true);
    setQuiz(null);
  }

  // A deck has no questions and nothing to hand in — the download IS the
  // work. The first one completes the item, the way a lesson completes when
  // watched to the end; a later one counts as a revision, exactly as markOpen
  // already does for a finished lesson. The deck branch below renders no quiz
  // button and no file picker: item.quiz is null for a deck (the worker
  // writes it no questions_json) and a submission row would be a file
  // answering nothing.
  //
  // PRODUCT DECISION (for the founder to confirm): completion is recorded on
  // the CLICK, not on the bytes arriving — the browser hands a download off to
  // its own manager and tells the page nothing.
  //
  // That is honest because the click no longer depends on anything this row
  // is holding. `deckUrl` for a deck is the ROUTE /api/deck/{genId}, which
  // never goes stale: it re-checks the share and mints a one-minute signed URL
  // (named Deck.pptx, so the click stays a download and iOS Safari cannot
  // open the .pptx inline and unload this row mid-write) at the moment it is
  // followed. The first cut rendered an hour-long signed URL here and tried to
  // refuse a stale one on the client by measuring the link's age from this
  // row's mount — which a client-router restore defeats exactly: back/forward
  // remounts the row with the CACHED hour-old URL and a fresh mount clock, so
  // the expired link passed, the row said "Completed", and the download failed
  // at storage. There is no client-side version of that check that works, so
  // there is no check here.
  //
  // The write's failure is SHOWN (the file path already does this; the first
  // version discarded it) and the row's status is left alone, so a failed
  // save never looks like a saved one. The download itself still goes ahead —
  // the deck is the student's either way.
  async function openDeck() {
    setError(null);
    if (status === "completed" || status === "revised") return markOpen();
    const at = new Date().toISOString();
    const { error: pErr } = await supabase
      .from("student_progress")
      .upsert(
        { ...base, status: "completed", opened_at: at, completed_at: at, progress_pct: 100 },
        { onConflict: "generation_id,student_id" },
      );
    if (pErr) {
      setError(pErr.message);
      return;
    }
    setStatus("completed");
  }

  const isLesson = item.kind === "presentation";
  const isDeck = item.kind === "deck";
  // For a DECK row this is /api/deck/{genId} — a route, not a signed URL, the
  // same way `item.quiz` is a route rather than a link to questions.json. For
  // a LESSON it is still that unit's embedded deck, signed at render. A deck
  // row is a single part-unit, so the first entry is the one. Absent means the
  // generation carried no deck_pptx when the page read it — a share only
  // exists once the row was "done", so that is a read that came back short,
  // which a refresh fixes; it is never an unbuilt deck.
  const deckUrl = item.decks?.[0] ?? item.deck;
  const done = status === "completed" || status === "revised" || submitted;
  const overdue = item.dueOverdue && !done;

  return (
    <li className="flex items-center justify-between gap-4 py-0.5">
      <span data-tour="progress" className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-[10px] uppercase tracking-wide text-[#98A0A9]">{item.label}</span>
        <Badge status={status} submitted={submitted} t={t.status} />
      </span>
      <span className="flex items-center gap-3 shrink-0 text-xs">
        {item.dueAt && (
          <span className={overdue ? "text-[#B42318]" : "text-[#5B6470]"}>
            {fmt(t.item.due, { date: new Date(item.dueAt).toLocaleDateString(lang) })}
          </span>
        )}
        {isLesson ? (
          <>
            {parts.length === 1 && !!parts[0] && (
              <button data-tour="open-lesson" onClick={() => watch()} className="font-medium text-[#0C8175] hover:underline">
                ▶ {t.item.watch}
              </button>
            )}
            {parts.length > 1 && (
              <span className="inline-flex items-center gap-1.5 flex-wrap">
                <button
                  data-tour="open-lesson"
                  onClick={() => watch()}
                  className="font-medium text-[#0C8175] hover:underline"
                >
                  {doneParts === 0
                    ? `▶ ${fmt(t.item.startFirstPart, { total: parts.length })}`
                    : doneParts >= parts.length
                      ? `▶ ${t.item.rewatch}`
                      : `▶ ${fmt(t.item.continuePart, { n: doneParts + 1, total: parts.length })}`}
                </button>
                <span className="text-[10px] text-[#98A0A9]">{t.item.eachAboutFifteenMinutes}</span>
                {parts.map((url, i) => (
                  <button
                    key={i}
                    onClick={() => url && watch(i)}
                    disabled={!url}
                    title={
                      !url
                        ? fmt(t.item.partWontLoad, { n: i + 1 })
                        : i < doneParts
                          ? fmt(t.item.rewatchPart, { n: i + 1 })
                          : fmt(t.item.part, { n: i + 1 })
                    }
                    className={`text-[10px] rounded-full px-1.5 py-0.5 disabled:opacity-40 ${
                      i < doneParts
                        ? "bg-[#E2F4F1] text-[#0C8175]"
                        : i === doneParts
                          ? "bg-[#FFF1D6] text-[#9A6400]"
                          : "bg-[#EEF0EC] text-[#98A0A9]"
                    }`}
                  >
                    {i < doneParts ? `✓${i + 1}` : i + 1}
                  </button>
                ))}
              </span>
            )}
            {(item.decks?.length ? item.decks : item.deck ? [item.deck] : []).map((url, i, all) => (
              <a key={`d${i}`} href={url} className="font-medium text-[#0C8175] hover:underline">
                ⬇ {all.length > 1 ? fmt(t.item.deckPart, { n: i + 1 }) : t.item.deck}
              </a>
            ))}
            {AI_TUTOR && (
              <button onClick={() => setCoaching(true)} className="font-medium text-[#0C8175] hover:underline">🎓 {t.item.assistant}</button>
            )}
          </>
        ) : isDeck ? (
          deckUrl ? (
            // `download` matches the ⬇ affordance; what the browser actually
            // obeys once the route redirects cross-origin is the signed URL's
            // own Content-Disposition, which /api/deck sets. Deliberately NO
            // target="_blank": the Library's rule for a disposition download
            // (content-cell.tsx) — it would strand an empty tab, and the
            // disposition already keeps this page in place.
            <a href={deckUrl} download onClick={() => void openDeck()} className="font-medium text-[#0C8175] hover:underline">
              ⬇ {t.item.deck}
            </a>
          ) : (
            <span className="text-[#98A0A9]">{t.item.deckWontLoad}</span>
          )
        ) : (
          <>
            {item.doc && (
              <a href={item.doc} className="font-medium text-[#0C8175] hover:underline">⬇ {t.item.open}</a>
            )}
            {item.quiz && (
              <button onClick={takeQuiz} className="font-medium text-[#0C8175] hover:underline">{t.item.takeQuiz}</button>
            )}
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="font-medium text-[#0C8175] hover:underline disabled:opacity-50">
              {busy ? t.item.uploading : submitted ? t.item.resubmit : t.item.submitFile}
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
          </>
        )}
      </span>

      {/* Visible, not sr-only: a failed file upload must be seen to be retried. */}
      {error && <span className="text-xs text-[#B42318]">{error}</span>}

      {playing && parts.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPlaying(false)}>
          <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            {endInfo ? (
              <div className="w-full rounded-lg bg-black/90 border border-white/10 px-8 py-14 text-center">
                <p className="text-lg text-white">
                  {endInfo.counted
                    ? `✓ ${fmt(t.player.partDone, { n: endInfo.part, total: parts.length })}`
                    : fmt(t.player.partFinished, { n: endInfo.part, total: parts.length })}
                </p>
                <p className="text-sm text-white/60 mt-1">
                  {endInfo.counted && endInfo.completed
                    ? `${t.player.lessonComplete} 🎉`
                    : endInfo.counted
                      ? t.player.onePartADay
                      : endInfo.completed
                        ? t.player.alreadyCompleted
                        : fmt(t.player.nextUpPart, { n: doneParts + 1 })}
                </p>
                <div className="flex items-center justify-center gap-3 mt-5">
                  {partIdx < parts.length - 1 && !!parts[partIdx + 1] && (
                    <button
                      onClick={() => {
                        setPartIdx(partIdx + 1);
                        setEndInfo(null);
                      }}
                      className="btn-primary h-10 px-4 text-sm"
                    >
                      ▶ {fmt(t.player.playPart, { n: partIdx + 2 })}
                    </button>
                  )}
                  <button onClick={() => setPlaying(false)} className="h-10 px-4 text-sm text-white/90 hover:underline">
                    {endInfo.counted && !endInfo.completed ? t.player.doneForToday : t.close}
                  </button>
                </div>
              </div>
            ) : parts[partIdx] ? (
              <video
                key={partIdx}
                src={parts[partIdx]!}
                controls
                autoPlay
                onEnded={onPartEnded}
                className="w-full rounded-lg bg-black"
              />
            ) : (
              <div className="w-full rounded-lg bg-black/90 border border-white/10 px-8 py-14 text-center">
                <p className="text-sm text-white/80">{fmt(t.player.partLoadFailed, { n: partIdx + 1 })}</p>
              </div>
            )}
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-white/70">
                {parts.length > 1
                  ? fmt(t.player.multiPartHint, { n: partIdx + 1, total: parts.length })
                  : t.player.singlePartHint}
              </p>
              <button onClick={() => setPlaying(false)} className="text-xs text-white/90 hover:underline">{t.close}</button>
            </div>
          </div>
        </div>
      )}

      {quiz && <QuizPlayer data={quiz} onClose={() => setQuiz(null)} onSubmit={onQuizSubmit} />}

      {coaching && (
        <AskCoach generationId={item.genId} studentId={studentId} chapterLabel={item.label} onClose={() => setCoaching(false)} />
      )}
    </li>
  );
}
