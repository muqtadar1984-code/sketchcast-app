// SK gap tracker — signal E, the 👎 on one of SK's replies: the request body
// POST /api/sk/gap-feedback takes, validated and cut. PURE (the route and the
// client share the limits).

export const GAP_NOTE_MAX = 300;
export const GAP_QUESTION_MAX = 600;
export const GAP_REPLY_MAX = 1000;
/** Earlier {q, a} pairs sent with a 👎 (the client has the transcript). */
export const GAP_PREVIOUS_MAX = 2;
/** 👎 rows one user may write in an hour. */
export const THUMBS_PER_HOUR = 30;

export type GapFeedbackBody = {
  turnId: string;
  question: string;
  reply: string;
  note: string | null;
  previous: Array<{ q: string; a: string }>;
  page: string | null;
};

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Over-long transcript text is cut, not refused (the client sends what it
 *  shows); a missing turnId or question, or a note over the box's limit, is refused. */
export function parseGapFeedback(raw: unknown): GapFeedbackBody | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid body." };
  const b = raw as Record<string, unknown>;
  const turnId = typeof b.turnId === "string" && b.turnId.trim() && b.turnId.length <= 80 ? b.turnId.trim() : "";
  if (!turnId) return { error: "turnId is required." };
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return { error: "Invalid note." };
  if (typeof b.note === "string" && b.note.trim().length > GAP_NOTE_MAX) return { error: `Keep it under ${GAP_NOTE_MAX} characters.` };
  const question = str(b.question, GAP_QUESTION_MAX);
  if (!question) return { error: "question is required." };
  const previous = Array.isArray(b.previous)
    ? b.previous
        .slice(-GAP_PREVIOUS_MAX)
        .map((p) => {
          const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
          return { q: str(o.q, GAP_QUESTION_MAX), a: str(o.a, GAP_REPLY_MAX) };
        })
        .filter((p) => p.q || p.a)
    : [];
  return {
    turnId,
    question,
    reply: str(b.reply, GAP_REPLY_MAX),
    note: str(b.note, GAP_NOTE_MAX) || null,
    previous,
    page: str(b.page, 300) || null,
  };
}

/** The client side: the 👎'd reply's question and up to GAP_PREVIOUS_MAX
 *  earlier {q, a} pairs, from transcript entries in order. An SK entry's
 *  question is the closest user entry before it. */
export function feedbackContext(
  entries: ReadonlyArray<{ id: string; who: "user" | "sk"; text: string }>,
  skId: string,
): { question: string; reply: string; previous: Array<{ q: string; a: string }> } | null {
  const i = entries.findIndex((e) => e.id === skId && e.who === "sk");
  if (i < 0) return null;
  const pairs: Array<{ q: string; a: string; at: number }> = [];
  let q: string | null = null;
  for (let k = 0; k <= i; k++) {
    const e = entries[k]!;
    if (e.who === "user") q = e.text;
    else if (q !== null) {
      pairs.push({ q, a: e.text, at: k });
      q = null;
    }
  }
  const last = pairs[pairs.length - 1];
  if (!last || last.at !== i) return null;
  return {
    question: last.q.slice(0, GAP_QUESTION_MAX),
    reply: last.a.slice(0, GAP_REPLY_MAX),
    previous: pairs.slice(0, -1).slice(-GAP_PREVIOUS_MAX).map((p) => ({ q: p.q.slice(0, GAP_QUESTION_MAX), a: p.a.slice(0, GAP_REPLY_MAX) })),
  };
}
