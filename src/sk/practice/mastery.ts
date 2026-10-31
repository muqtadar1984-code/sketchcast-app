// Worksheet practice — MASTERY PER CONCEPT PER STUDENT, rule `sk-learn.1`
// (SK student Board plan 2026-10-31, phase 4). PURE and deterministic: the
// same attempts always give the same scores, so nothing is stored — every
// surface computes it on read from sk_practice_attempts (0178) and the cached
// concept tags (0179). Why on read: the attempts are the record; a class is a
// few thousand rows; there is no second copy to go stale or to repair when
// the rule changes (the version names the rule, as 0157's mastery_state does).
//
// THE UNIT OF EVIDENCE is an EPISODE: one question, in one practice session —
// her first answer to the last thing she did on it. Like SK B5's rule
// (src/sk/mastery.ts), only DETERMINISTIC grades count: a written answer sent
// to her teacher (outcome "review", type "subjective") is no evidence here.
//
// THE CREDIT of an episode (first-try correct weighs most; help reduces it):
//   right on the first try, no help ...................... 1.00
//   right after a HINT (one wrong answer or a help tap) .. 0.70
//   right after a WORKED STEP ............................ 0.40
//   right only after the ANSWER rung ...................... 0.10
//   never right, after a wrong answer or the answer rung . 0.00
//   help taps only, no answer, no answer rung ............ not evidence
// (each wrong answer or help tap climbs one rung — help.ts — so the highest
// rung she reached BEFORE her right answer captures both her misses and her
// help).
//
// THE SCORE of a concept is the RECENCY-WEIGHTED mean of its episodes'
// credits, × 100, rounded: an episode's weight halves every 14 days of age
// (HALF_LIFE_DAYS), so last week's practice outweighs last month's.
//
// THE BAND:
//   new       fewer than 2 episodes — not enough to say;
//   secure    ≥ 3 episodes and a score of 80 or more;
//   learning  everything else.
// A concept is keyed per KIT (the practice session's kit) and per concept key
// (a lesson-map concept id, a paper concept, or "kit" — concepts.ts).

export const LEARN_MASTERY_RULE = "sk-learn.1";
export const HALF_LIFE_DAYS = 14;
export const SECURE_SCORE = 80;
export const SECURE_MIN_EPISODES = 3;
export const NEW_BELOW_EPISODES = 2;

export const CREDIT = { first: 1, hint: 0.7, step: 0.4, answer: 0.1, wrong: 0 } as const;

export type Band = "new" | "learning" | "secure";

/** An sk_practice_attempts row, as the readers select it. */
export type PracticeAttemptRow = {
  session_id: string;
  student_id: string;
  generation_id: string;
  question_id: string;
  question_type: string;
  concept: string | null;
  kind: "answer" | "help" | string;
  outcome: "correct" | "incorrect" | "review" | "help" | string;
  rung: "none" | "hint" | "step" | "answer" | string;
  attempt_no: number;
  created_at: string;
};

export type ConceptRef = { key: string; name: string };

export type Episode = {
  studentId: string;
  kitId: string;
  concept: ConceptRef;
  generationId: string;
  questionId: string;
  /** null = not evidence. */
  credit: number | null;
  /** ms since the epoch of the episode's last row. */
  at: number;
};

export type ConceptMastery = {
  studentId: string;
  kitId: string;
  key: string;
  name: string;
  /** 0–100. */
  score: number;
  band: Band;
  /** Episodes that count. */
  evidence: number;
  /** Of those, right on the first try with no help. */
  firstTry: number;
  lastAt: string;
  rule: typeof LEARN_MASTERY_RULE;
};

/** "Cell organelles!" → "cell-organelles": a paper-named concept's key (after "p:"). */
export function conceptSlug(s: string): string {
  return (
    String(s ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 100) || "concept"
  );
}

const RUNG_ORDER: Record<string, number> = { none: 0, hint: 1, step: 2, answer: 3 };

/** One episode's credit from its rows (any order). */
export function episodeCredit(rows: readonly Pick<PracticeAttemptRow, "kind" | "outcome" | "rung" | "attempt_no" | "question_type">[]): number | null {
  if (!rows.length) return null;
  if (rows.some((r) => r.outcome === "review" || r.question_type === "subjective")) return null;
  const ordered = [...rows].sort((a, b) => a.attempt_no - b.attempt_no);
  const right = ordered.findIndex((r) => r.outcome === "correct");
  const before = right < 0 ? ordered : ordered.slice(0, right);
  const top = Math.max(0, ...before.map((r) => RUNG_ORDER[r.rung] ?? 0));
  if (right >= 0) return top === 0 ? CREDIT.first : top === 1 ? CREDIT.hint : top === 2 ? CREDIT.step : CREDIT.answer;
  const answered = ordered.some((r) => r.kind === "answer");
  return answered || top >= 3 ? CREDIT.wrong : null;
}

export const bandOf = (score: number, evidence: number): Band => (evidence < NEW_BELOW_EPISODES ? "new" : evidence >= SECURE_MIN_EPISODES && score >= SECURE_SCORE ? "secure" : "learning");

export const recencyWeight = (atMs: number, nowMs: number): number => Math.pow(0.5, Math.max(0, nowMs - atMs) / 86_400_000 / HALF_LIFE_DAYS);

export type MasteryInput = {
  attempts: readonly PracticeAttemptRow[];
  /** practice session id → its kit. */
  sessionKit: ReadonlyMap<string, string>;
  /** `${worksheet}:${question}` → the cached concept tag. */
  tags: ReadonlyMap<string, ConceptRef>;
  /** The kit's name (the kit-level concept). */
  kitName: (kitId: string) => string;
  now: number;
};

/** Attempts → episodes, each with its concept (tag → paper's own → the kit). */
export function episodesOf(input: MasteryInput): Episode[] {
  const groups = new Map<string, PracticeAttemptRow[]>();
  for (const a of input.attempts) {
    if (!a || !a.session_id || !a.question_id) continue;
    const k = `${a.session_id}|${a.generation_id}|${a.question_id}`;
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  const out: Episode[] = [];
  for (const rows of groups.values()) {
    const a = rows[0];
    const kitId = input.sessionKit.get(a.session_id);
    if (!kitId) continue;
    const tag = input.tags.get(`${a.generation_id}:${a.question_id}`);
    const paper = rows.find((r) => typeof r.concept === "string" && r.concept.trim())?.concept?.trim();
    const concept: ConceptRef = tag ?? (paper ? { key: `p:${conceptSlug(paper)}`, name: paper } : { key: "kit", name: input.kitName(kitId) });
    const at = Math.max(...rows.map((r) => Date.parse(r.created_at)).filter((t) => Number.isFinite(t)), 0);
    out.push({ studentId: a.student_id, kitId, concept, generationId: a.generation_id, questionId: a.question_id, credit: episodeCredit(rows), at });
  }
  return out;
}

/** Episodes → one mastery row per (student, kit, concept), weakest first. */
export function masteryOf(episodes: readonly Episode[], now: number): ConceptMastery[] {
  const groups = new Map<string, Episode[]>();
  for (const e of episodes) {
    if (e.credit === null) continue;
    const k = `${e.studentId}|${e.kitId}|${e.concept.key}`;
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const out: ConceptMastery[] = [];
  for (const list of groups.values()) {
    let sw = 0;
    let swc = 0;
    for (const e of list) {
      const w = recencyWeight(e.at, now);
      sw += w;
      swc += w * (e.credit as number);
    }
    const score = sw > 0 ? Math.round((100 * swc) / sw) : 0;
    const last = Math.max(...list.map((e) => e.at));
    out.push({
      studentId: list[0].studentId,
      kitId: list[0].kitId,
      key: list[0].concept.key,
      name: list[0].concept.name,
      score,
      band: bandOf(score, list.length),
      evidence: list.length,
      firstTry: list.filter((e) => e.credit === CREDIT.first).length,
      lastAt: new Date(last || now).toISOString(),
      rule: LEARN_MASTERY_RULE,
    });
  }
  return out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
}

export const computeMastery = (input: MasteryInput): ConceptMastery[] => masteryOf(episodesOf(input), input.now);

/** Counts per band (a student's or a class's summary line). */
export function bandCounts(rows: readonly Pick<ConceptMastery, "band">[]): Record<Band, number> {
  const c: Record<Band, number> = { new: 0, learning: 0, secure: 0 };
  for (const r of rows) c[r.band] += 1;
  return c;
}

export type ClassConcept = { kitId: string; key: string; name: string; students: number; avg: number; secure: number; learning: number; new: number };

/** A class view: per (kit, concept), how many students and how secure, weakest first. */
export function classConcepts(rows: readonly ConceptMastery[]): ClassConcept[] {
  const g = new Map<string, ClassConcept & { sum: number }>();
  for (const r of rows) {
    const k = `${r.kitId}|${r.key}`;
    const c = g.get(k) ?? { kitId: r.kitId, key: r.key, name: r.name, students: 0, avg: 0, secure: 0, learning: 0, new: 0, sum: 0 };
    c.students += 1;
    c.sum += r.score;
    c[r.band] += 1;
    g.set(k, c);
  }
  return [...g.values()]
    .map(({ sum, ...c }) => ({ ...c, avg: c.students ? Math.round(sum / c.students) : 0 }))
    .sort((a, b) => a.avg - b.avg || a.name.localeCompare(b.name));
}
