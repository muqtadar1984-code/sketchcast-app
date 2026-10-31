"use client";

// Worksheet practice on the student Board (SK student Board plan 2026-10-31,
// phase 2): the answer box under each question page, the help ladder's words,
// and the score at the end.
//
// usePractice() lives in the Board's host (present-client), so what she has
// done on each question survives turning pages; <PracticePanel> is drawn under
// the roll on a question page only. Every answer goes to the server
// (/api/present/learn/answer), which checks it against the key — the browser
// never holds the key until the ladder's third rung reveals it.
//
// Phone-friendly: every control is ≥ 44 px tall and every text input is 16 px
// (iOS zooms the page on a smaller one).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextCard } from "@/board/model";
import { fmt } from "@/i18n/format";
import type { PresentWords } from "./present-client";
import {
  applyReply,
  dispatchGap,
  emptyQuestion,
  endLine,
  finished,
  gapDetail,
  keyLine,
  practiceKey,
  practiceSummary,
  type PracticeReply,
  type QuestionState,
  type Rung,
} from "./practice";

export type PracticeWords = PresentWords["learn"]["practice"];


export type Practice = {
  state: ReadonlyMap<string, QuestionState>;
  busy: string | null;
  error: { key: string; text: string } | null;
  submit: (card: TextCard, cards: readonly TextCard[], kind: "answer" | "help", answer?: unknown) => Promise<void>;
  /** Note when a question page comes into view (its time starts then). */
  seen: (card: TextCard) => void;
  /** The kit being practised (the end-of-worksheet mastery summary reads it). */
  kitId: string | null;
};

/**
 * The practice state for ONE Board session (`sessionId` = the learner
 * session's uuid = the practice session's id on the server).
 */
export function usePractice(o: { sessionId: string | null; kitId: string | null; words: PracticeWords; say: (line: string) => void }): Practice {
  const { sessionId, kitId, words, say } = o;
  const [store, setStore] = useState<{ session: string | null; map: ReadonlyMap<string, QuestionState> }>({ session: null, map: new Map() });
  const state = useMemo(() => (store.session === sessionId ? store.map : new Map<string, QuestionState>()), [store, sessionId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const started = useRef(new Map<string, number>());
  const announced = useRef<string | null>(null);
  const live = useRef(state);
  useEffect(() => {
    live.current = state;
  }, [state]);

  const seen = useCallback((card: TextCard) => {
    const k = practiceKey(card.generationId, card.questionId);
    if (!started.current.has(k)) started.current.set(k, Date.now());
  }, []);

  const submit = useCallback(
    async (card: TextCard, cards: readonly TextCard[], kind: "answer" | "help", answer?: unknown) => {
      if (!sessionId || !kitId || !card.generationId || !card.questionId) return;
      const k = practiceKey(card.generationId, card.questionId);
      const prev = live.current.get(k) ?? emptyQuestion();
      if (kind === "help") {
        // She asked: SK's teaching hears about it straight away (phase 3).
        dispatchGap(
          gapDetail({
            generationId: card.generationId,
            questionId: card.questionId,
            questionText: card.heading,
            concept: prev.concept,
            attempts: prev.attempts,
            lastAnswer: prev.lastAnswer,
            reason: "asked_help",
          }),
        );
      }
      setBusy(k);
      setError(null);
      const t0 = started.current.get(k) ?? Date.now();
      try {
        const r = await fetch("/api/present/learn/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, kitId, generationId: card.generationId, questionId: card.questionId, kind, answer, ms: Date.now() - t0 }),
        });
        const body = (await r.json().catch(() => null)) as (PracticeReply & { error?: string; done?: boolean }) | null;
        if (r.status === 409 && body?.done) {
          const next = new Map(live.current);
          next.set(k, { ...prev, done: true });
          live.current = next;
          setStore({ session: sessionId, map: next });
          return;
        }
        if (!r.ok || !body || typeof body.outcome !== "string") {
          setError({ key: k, text: r.status === 429 ? words.slowDown : words.failed });
          return;
        }
        started.current.set(k, Date.now());
        const q = applyReply(prev, body, answer);
        const next = new Map(live.current);
        next.set(k, q);
        live.current = next;
        setStore({ session: sessionId, map: next });
        if (body.gap === "wrong_twice") {
          dispatchGap(
            gapDetail({
              generationId: card.generationId,
              questionId: card.questionId,
              questionText: card.heading,
              concept: q.concept,
              attempts: q.attempts,
              lastAnswer: q.lastAnswer,
              reason: "wrong_twice",
            }),
          );
        }
        const list = cards.filter((c) => c.generationId === card.generationId).map((c) => ({ qtype: c.qtype, key: practiceKey(c.generationId, c.questionId) }));
        const sum = practiceSummary(list, next);
        const tag = `${sessionId}:${card.generationId}`;
        if (sum.finished && announced.current !== tag) {
          announced.current = tag;
          say(endLine(sum, words));
        }
      } catch {
        setError({ key: k, text: words.failed });
      } finally {
        setBusy(null);
      }
    },
    [sessionId, kitId, words, say],
  );

  return { state, busy, error, submit, seen, kitId };
}

const BTN = "min-h-11 rounded-lg px-4 py-2 text-base";

type MasteryLine = { key: string; name: string; score: number; band: "new" | "learning" | "secure" };
const BAND_TONE: Record<MasteryLine["band"], string> = {
  secure: "border-[#17544C] bg-[#12302C] text-[#C9F2EA]",
  learning: "border-[#4A3A1C] bg-[#2C2318] text-[#F1D9B0]",
  new: "border-[#2A363B] bg-[#141B1F] text-[#C2CCC7]",
};

/**
 * Phase 4: at the end of a worksheet, HER mastery per idea of this kit
 * (GET /api/present/learn/mastery — her own rows, rule sk-learn.1), weakest
 * first, with a note that a plan goes to her teacher or parent.
 */
function MasterySummary({ kitId, words }: { kitId: string; words: PracticeWords }) {
  const [rows, setRows] = useState<MasteryLine[] | null>(null);
  useEffect(() => {
    let live = true;
    // The after-work (concept tags) runs after her last reply: give it a moment.
    const t = setTimeout(() => {
      fetch(`/api/present/learn/mastery?kitId=${encodeURIComponent(kitId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { concepts?: MasteryLine[] } | null) => {
          if (live) setRows(Array.isArray(b?.concepts) ? b!.concepts!.slice(0, 8) : []);
        })
        .catch(() => live && setRows([]));
    }, 1500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kitId]);
  if (!rows || !rows.length) return null;
  return (
    <div className="grid gap-2 rounded-lg border border-[#222C30] bg-[#0F1417] px-3 py-2" data-practice="mastery">
      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#9FB0AA]">{words.masteryTitle}</p>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <li key={r.key} className={`rounded-full border px-3 py-1 text-sm ${BAND_TONE[r.band]}`}>
            {r.name} · {words.band[r.band]}
          </li>
        ))}
      </ul>
      <p className="text-sm text-[#C2CCC7]">{words.masteryNote}</p>
    </div>
  );
}
const RUNG_TONE: Record<Rung, string> = {
  hint: "border-[#17544C] bg-[#12302C] text-[#C9F2EA]",
  step: "border-[#4A3A1C] bg-[#2C2318] text-[#F1D9B0]",
  answer: "border-[#2A363B] bg-[#141B1F] text-[#E7EDE9]",
};

export function PracticePanel({
  card,
  cards,
  practice,
  words,
  boolWords,
  onNext,
}: {
  card: TextCard;
  cards: readonly TextCard[];
  practice: Practice;
  words: PracticeWords;
  boolWords: { answerTrue: string; answerFalse: string };
  onNext: () => void;
}) {
  const k = practiceKey(card.generationId, card.questionId);
  const q = practice.state.get(k) ?? emptyQuestion();
  const busy = practice.busy === k;
  const [draft, setDraft] = useState<{ key: string; text: string; picks: string[] }>({ key: k, text: "", picks: [] });
  const d = draft.key === k ? draft : { key: k, text: "", picks: [] };
  const { seen } = practice;
  useEffect(() => seen(card), [seen, card]);

  const type = card.qtype ?? "short";
  const lefts = type === "match" ? card.body.map((b) => b.replace(/^\d+\.\s*/, "")) : [];
  const closed = finished(q);
  const last = (card.index ?? 0) >= (card.total ?? 1) - 1;

  const send = (answer: unknown) => void practice.submit(card, cards, "answer", answer);
  const typed = d.text.trim();
  const matchReady = type === "match" && lefts.length > 0 && lefts.every((_, i) => !!d.picks[i]);

  const list = useMemo(
    () => cards.filter((c) => c.generationId === card.generationId).map((c) => ({ qtype: c.qtype, key: practiceKey(c.generationId, c.questionId) })),
    [cards, card.generationId],
  );
  const sum = practiceSummary(list, practice.state);

  const feedback =
    q.correct ? words.correct : q.review ? words.review : q.attempts > 0 && !q.correct ? (q.answer ? words.shown : words.incorrect) : null;

  return (
    <section className="grid gap-3 rounded-xl border border-[#222C30] bg-[#0F1417] p-3 text-[#E7EDE9]" data-board="practice" aria-live="polite">
      {!closed && (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (type === "match") {
              if (matchReady) send(lefts.map((_, i) => d.picks[i]));
            } else if (typed) send(typed);
          }}
        >
          {type === "mcq" && (card.options ?? []).length > 0 ? (
            <div className="grid gap-2" role="group" aria-label={words.answerLabel}>
              {(card.options ?? []).map((opt, i) => (
                <button
                  key={`${i}:${opt}`}
                  type="button"
                  disabled={busy}
                  onClick={() => send(opt)}
                  className={`${BTN} border border-[#2A363B] bg-[#141B1F] text-start text-[#E7EDE9] disabled:opacity-50`}
                  data-practice-option={i}
                >
                  <span className="me-2 font-mono text-[#4FD6C2]">{String.fromCharCode(65 + i)}.</span>
                  {opt}
                </button>
              ))}
            </div>
          ) : type === "true_false" ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={words.answerLabel}>
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  disabled={busy}
                  onClick={() => send(v)}
                  className={`${BTN} min-w-28 flex-1 border border-[#2A363B] bg-[#141B1F] text-[#E7EDE9] disabled:opacity-50`}
                  data-practice-bool={String(v)}
                >
                  {v ? boolWords.answerTrue : boolWords.answerFalse}
                </button>
              ))}
            </div>
          ) : type === "match" ? (
            <div className="grid gap-2">
              {lefts.map((l, i) => (
                <label key={`${i}:${l}`} className="grid gap-1 text-sm text-[#C2CCC7] sm:grid-cols-[1fr_1fr] sm:items-center sm:gap-3">
                  <span>
                    {i + 1}. {l}
                  </span>
                  <select
                    value={d.picks[i] ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const picks = [...d.picks];
                      picks[i] = e.target.value;
                      setDraft({ key: k, text: d.text, picks });
                    }}
                    className="min-h-11 rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-base text-[#E7EDE9]"
                  >
                    <option value="">{words.choose}</option>
                    {(card.options ?? []).map((opt, j) => (
                      <option key={`${j}:${opt}`} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <label className="grid gap-1 text-sm text-[#C2CCC7]">
              {words.answerLabel}
              {type === "subjective" ? (
                <textarea
                  value={d.text}
                  disabled={busy}
                  rows={4}
                  maxLength={500}
                  onChange={(e) => setDraft({ key: k, text: e.target.value, picks: d.picks })}
                  placeholder={words.placeholder}
                  className="min-h-24 rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-base text-[#E7EDE9]"
                />
              ) : (
                <input
                  value={d.text}
                  disabled={busy}
                  maxLength={500}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(e) => setDraft({ key: k, text: e.target.value, picks: d.picks })}
                  placeholder={words.placeholder}
                  className="min-h-11 rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-base text-[#E7EDE9]"
                  data-practice-input
                />
              )}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {(type !== "mcq" || !(card.options ?? []).length) && type !== "true_false" && (
              <button
                type="submit"
                disabled={busy || (type === "match" ? !matchReady : !typed)}
                className={`${BTN} bg-[#0C8175] font-medium text-white disabled:opacity-50`}
                data-practice="check"
              >
                {busy ? words.checking : words.check}
              </button>
            )}
            {!q.answer && !q.locked && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void practice.submit(card, cards, "help")}
                className={`${BTN} border border-[#2A363B] bg-[#141B1F] text-[#C2CCC7] disabled:opacity-50`}
                data-practice="help"
              >
                {words.help}
              </button>
            )}
          </div>
        </form>
      )}

      {feedback && (
        <p className={`text-base ${q.correct ? "text-[#4FD6C2]" : q.review ? "text-[#C2CCC7]" : "text-[#E7B05C]"}`} data-practice="feedback">
          {feedback}
        </p>
      )}
      {practice.error?.key === k && (
        <p role="alert" className="text-sm text-[#E0A664]">
          {practice.error.text}
        </p>
      )}

      {q.help.map((h) => (
        <div key={h.rung} className={`rounded-lg border px-3 py-2 text-base ${RUNG_TONE[h.rung]}`} data-practice-rung={h.rung}>
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] opacity-80">{words.rung[h.rung]}</p>
          {h.rung === "answer" && q.answer && <p className="font-semibold">{keyLine(q.answer, boolWords)}</p>}
          <p>{h.text ?? words.generic[h.rung]}</p>
        </div>
      ))}

      {q.locked && !q.answer && (
        <p className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-base text-[#E7EDE9]" data-practice="locked">
          {words.locked}
        </p>
      )}

      {(closed || q.answer || q.locked) && !last && (
        <button type="button" onClick={onNext} className={`${BTN} justify-self-start bg-[#0C8175] font-medium text-white`} data-practice="next">
          {words.next} ›
        </button>
      )}

      {sum.finished && (
        <p className="rounded-lg border border-[#17544C] bg-[#12302C] px-3 py-2 text-base font-medium text-[#4FD6C2]" data-practice="score">
          {fmt(words.score, { correct: sum.correct, total: sum.total })} · {sum.hints === 1 ? words.hintOne : fmt(words.hintMany, { n: sum.hints })}
        </p>
      )}
      {sum.finished && practice.kitId && <MasterySummary kitId={practice.kitId} words={words} />}
    </section>
  );
}
