// Text pages on the roll: one kit question, or a slide's caption.
//
// ONE RENDERER FOR BOTH, AND IT DRAWS ON CANVAS. The page is a background like
// a frozen frame, so ink, undo, page up/down and the store work on it unchanged.
// The PDF export gets the same pixels (cardPng) rather than pdf-lib text,
// because the export's standard font is WinAnsi-only and a Hindi or Arabic
// question would throw and take the whole PDF with it.
//
// ANSWERS NEVER ENTER THE BACKGROUND. They come from questions.json into a map
// the host keeps in memory and are drawn only while the teacher has them shown;
// the persisted page, and therefore the PDF a student opens, holds the question.

import { PAGE_H, PAGE_W, type TextCard } from "@/board/model";
import type { Rect } from "@/board/render";

export type CardWords = {
  /** "Question {n} of {total}" */
  questionOf: string;
  /** "{n} marks" */
  marks: string;
  /** "Answer: {a}" */
  answer: string;
  answerTrue: string;
  answerFalse: string;
};

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

// ── questions.json → cards ───────────────────────────────────────────────────

type RawQ = {
  id?: unknown;
  type?: unknown;
  prompt?: unknown;
  options?: unknown;
  answer?: unknown;
  accept?: unknown;
  pairs?: unknown;
  answer_outline?: unknown;
  marks?: unknown;
};

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/**
 * Turn a worksheet's questions.json into one card per question, and pull the
 * answer key out into its own map. Malformed items are skipped, not guessed.
 */
export function questionCards(
  raw: unknown,
  generationId: string,
  words: Pick<CardWords, "answerTrue" | "answerFalse">,
): { cards: TextCard[]; answers: Map<string, string> } {
  const qs = raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions)
    ? ((raw as { questions: unknown[] }).questions as RawQ[])
    : [];
  const usable = qs.filter((q) => q && typeof q === "object" && typeof q.prompt === "string" && q.prompt.trim());
  const cards: TextCard[] = [];
  const answers = new Map<string, string>();
  usable.forEach((q, i) => {
    const id = str(q.id) || `q${i + 1}`;
    const card: TextCard = {
      source: "question",
      heading: str(q.prompt),
      body: [],
      generationId,
      questionId: id,
      index: i,
      total: usable.length,
    };
    if (typeof q.marks === "number") card.marks = q.marks;
    let answer = "";
    switch (q.type) {
      case "mcq":
        card.options = Array.isArray(q.options) ? q.options.map(str) : [];
        answer = str(q.answer);
        break;
      case "true_false":
        answer = q.answer === true ? words.answerTrue : q.answer === false ? words.answerFalse : "";
        break;
      case "match": {
        const pairs = Array.isArray(q.pairs)
          ? (q.pairs as { left?: unknown; right?: unknown }[]).map((p) => ({ left: str(p?.left), right: str(p?.right) }))
          : [];
        card.body = pairs.map((p, n) => `${n + 1}. ${p.left}`);
        // The right-hand column in a fixed order that is NOT the key's order.
        card.options = pairs.map((p) => p.right).sort((a, b) => a.localeCompare(b));
        answer = pairs.map((p) => `${p.left} → ${p.right}`).join(" · ");
        break;
      }
      case "subjective":
        answer = str(q.answer_outline);
        break;
      default:
        answer = str(q.answer);
    }
    cards.push(card);
    if (answer) answers.set(answerKey(generationId, id), answer);
  });
  return { cards, answers };
}

/**
 * The STUDENT Board's cards (learner mode, 2026-10-31): the same one card per
 * question, from the answer-STRIPPED paper /api/quiz/{id} serves a student —
 * never questions.json. That shape has no answers at all (a match question
 * carries `left` and a shuffled `options` column instead of `pairs`), and
 * this returns NO answer map, so the Board has nothing to reveal.
 */
export function learnerQuestionCards(raw: unknown, generationId: string): { cards: TextCard[]; answers: Map<string, string> } {
  const qs = raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions)
    ? ((raw as { questions: unknown[] }).questions as (RawQ & { left?: unknown })[])
    : [];
  const usable = qs.filter((q) => q && typeof q === "object" && typeof q.prompt === "string" && q.prompt.trim());
  const cards: TextCard[] = usable.map((q, i) => {
    const card: TextCard = {
      source: "question",
      heading: str(q.prompt),
      body: [],
      generationId,
      questionId: str(q.id) || `q${i + 1}`,
      index: i,
      total: usable.length,
    };
    if (typeof q.marks === "number" && q.marks > 0) card.marks = q.marks;
    if (q.type === "mcq" && Array.isArray(q.options)) card.options = q.options.map(str);
    if (q.type === "match") {
      const left = Array.isArray(q.left) ? q.left.map(str) : [];
      card.body = left.map((l, n) => `${n + 1}. ${l}`);
      card.options = Array.isArray(q.options) ? q.options.map(str) : [];
    }
    return card;
  });
  return { cards, answers: new Map() };
}

export const answerKey = (generationId: string | undefined, questionId: string | undefined) =>
  `${generationId ?? ""}:${questionId ?? ""}`;

// ── layout + drawing ─────────────────────────────────────────────────────────

type Measure = (text: string, font: string) => number;

export type CardLine = { text: string; font: string; color: string; gap: number };

const FONT = "system-ui, sans-serif";
const MARGIN = 72;

/** Greedy word wrap; a single word longer than the line is broken by characters. */
export function wrap(text: string, width: number, font: string, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (measure(next, font) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (measure(w, font) <= width) {
        line = w;
      } else {
        let chunk = "";
        for (const ch of Array.from(w)) {
          if (measure(chunk + ch, font) > width && chunk) {
            out.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}

/** Every line the card shows, in order. Pure — tested without a canvas. */
export function layoutCard(
  card: TextCard,
  words: CardWords,
  answer: string | null,
  measure: Measure,
  width = PAGE_W - MARGIN * 2,
): CardLine[] {
  const lines: CardLine[] = [];
  const add = (text: string, size: number, weight: number, color: string, gap: number) => {
    const font = `${weight} ${size}px ${FONT}`;
    wrap(text, width, font, measure).forEach((t, i) =>
      lines.push({ text: t, font, color, gap: i === 0 ? gap : Math.round(size * 0.35) }),
    );
  };
  const meta: string[] = [];
  if (card.source === "question" && typeof card.index === "number" && typeof card.total === "number") {
    meta.push(fill(words.questionOf, { n: card.index + 1, total: card.total }));
  }
  if (typeof card.marks === "number") meta.push(fill(words.marks, { n: card.marks }));
  if (meta.length) add(meta.join(" · "), 26, 500, "#5F6F69", 0);
  if (card.heading) add(card.heading, 46, 600, "#14181F", meta.length ? 18 : 0);
  for (const b of card.body) add(b, 34, 400, "#14181F", 16);
  (card.options ?? []).forEach((o, i) => add(`${String.fromCharCode(65 + i)}. ${o}`, 34, 400, "#14181F", 14));
  if (answer) add(fill(words.answer, { a: answer }), 34, 600, "#0C8175", 30);
  return lines;
}

/** Draw a card into a page-sized box. Text that runs past the page is clipped by the caller's page clip. */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  card: TextCard,
  page: Rect,
  words: CardWords,
  answer: string | null,
): void {
  const measure: Measure = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  ctx.fillStyle = card.source === "question" ? "#F1F5F3" : "#FFFFFF";
  ctx.fillRect(0, 0, page.w, page.h);
  ctx.textBaseline = "top";
  let y = MARGIN;
  for (const l of layoutCard(card, words, answer, measure, page.w - MARGIN * 2)) {
    y += l.gap;
    ctx.font = l.font;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, MARGIN, y);
    const size = Number(/(\d+)px/.exec(l.font)?.[1] ?? 32);
    y += Math.round(size * 1.2);
  }
}

/** The card as PNG bytes for the PDF export. Null where there is no canvas. */
export async function cardPng(card: TextCard, words: CardWords): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = PAGE_W;
  c.height = PAGE_H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  drawCard(ctx, card, { x: 0, y: 0, w: PAGE_W, h: PAGE_H }, words, null);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
