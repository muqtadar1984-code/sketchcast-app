// SK S3 slice C — the remediation ladder (Final Plan §4.2; design decision 4:
// derived at runtime from the bank, NO model call). Pure and deterministic:
// the same item, choice, attempt and kit map always give the same rung, so
// the server can REPLAY the rungs it served earlier from the stored attempts
// instead of storing them (see ladderHistory).
//
// On a wrong answer, the next rung not yet served:
//   1  the misconception: the chosen option's `distractor_rationale[key]
//      .misconception_ref` → the article's {misconception, correction}
//      ("It looks like you're thinking X. Actually, Y."); without a ref, the
//      option's own `why_wrong`. Only when the item has a rationale for the
//      chosen option (every mcq distractor does; other types usually not, so
//      they start at rung 2).
//   2  a hint: the explanation (else the objective's text) with every sentence
//      that would give the answer away taken out.
//   3  slide(k): the kit-map section that teaches the item (its segment_ids,
//      else segmentForConcept of its concept).
//   4  a check question: a DIFFERENT bank item of the kit on the same
//      objective_key (else the same concept); or "none — here is the
//      explanation". Offered once the tries are used up.
// A right answer at any rung ends the ladder (the caller does not ask).
// After the last attempt (MAX_ATTEMPTS) the rest of the ladder (3, 4) comes
// with the answer revealed.
//
// THE ANSWER NEVER LEAKS BEFORE THE REVEAL: every text a rung carries passes
// `leaks()` — no sentence that contains the right option's text (or the
// fill-in answer, the true/false word, a match pair's right side), and for an
// mcq no stand-alone mention of the answer key ("B", "(B)", "option B").

import type { DistractorRationale, QuestionOption } from "@/utils/catalogue/questions";
import { MAX_ATTEMPTS } from "./grade";
import type { KitManifest, ManifestItem } from "./manifest/derive";
import { segmentForConcept } from "./manifest/board";
import type { KitReveal, KitRung } from "./kit-player";
import { objectiveKey } from "./objective-key";

export type ArticleMisconception = { id: string; misconception: string; correction: string };

/** What the ladder knows about one bank item (src/sk/remediation-bank.ts reads it). */
export type RemediationFacts = {
  itemId: string;
  /** The grader's type (RawQuestion.type): assertion_reason marks as mcq. */
  type: "mcq" | "true_false" | "fill_blank" | "match" | "short" | "subjective";
  /** mcq: the stored keyed options. */
  options: QuestionOption[];
  /** mcq: the right option's key. */
  answerKey: string | null;
  /** Every text that would give the answer away (the right option's text, the
   *  fill-in answer and its accepted forms, the true/false word, match rights). */
  answerTexts: string[];
  /** The answer as the reveal shows it. */
  answerDisplay: string;
  rationale: DistractorRationale;
  explanation: string | null;
  misconceptions: ArticleMisconception[];
  /** topic_articles.objectives[objective_ref].text — the fallback hint. */
  objectiveText: string | null;
  /** "<article_id>:<objective_ref>" (src/sk/objective-key.ts); null = unmapped. */
  objectiveKey: string | null;
};

export type RungNo = 1 | 2 | 3 | 4;

export type RemediationStep = {
  rungs: KitRung[];
  /** The tries are used up: the answer is revealed. */
  final: boolean;
  reveal: KitReveal | null;
};

export type RemediationOptions = {
  /** Rungs already served on this item (from ladderHistory). */
  served?: readonly RungNo[];
  /** Items the check question must not be (already asked in this session). */
  exclude?: Iterable<string>;
  /** Kit items' objective keys from their bank rows (bank id → key). Without
   *  it, a key is derived only for objective_ref-mapped items of the map. */
  objectiveKeys?: Readonly<Record<string, string | null>>;
};

// ── the answer must not leak ────────────────────────────────────────────────

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A stand-alone mention of an option key: "B", "(B)", "B)", "option B". Case
 *  matters for a one-letter key ("a" the word is not option "A"). */
export function mentionsKey(text: string, key: string): boolean {
  const k = key.trim();
  if (!k) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}(?=$|[^\\p{L}\\p{N}])`, k.length === 1 ? "u" : "iu");
  return re.test(text);
}

/** Would this text give the answer away? */
export function leaks(text: string, f: Pick<RemediationFacts, "type" | "answerKey" | "answerTexts">): boolean {
  const n = norm(text);
  for (const a of f.answerTexts) {
    const na = norm(a);
    if (na.trim() && n.includes(na)) return true;
  }
  return f.type === "mcq" && !!f.answerKey && mentionsKey(text, f.answerKey);
}

/** The sentences of `text` that do not leak, joined; null when too little is left. */
export function redact(text: string | null | undefined, f: Pick<RemediationFacts, "type" | "answerKey" | "answerTexts">): string | null {
  if (typeof text !== "string") return null;
  const kept = text
    .split(/(?<=[.!?。؟।])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s && !leaks(s, f));
  const out = kept.join(" ").trim();
  return out.length >= 8 ? out : null;
}

// ── the rungs ───────────────────────────────────────────────────────────────

function rationaleFor(f: RemediationFacts, chosenKey: string | null): { why_wrong: string; misconception_ref?: string | null } | null {
  if (!chosenKey) return null;
  const k = chosenKey.trim().toUpperCase();
  if (f.answerKey && k === f.answerKey.trim().toUpperCase()) return null; // the right option has no "why wrong"
  for (const [key, v] of Object.entries(f.rationale ?? {})) {
    if (key.trim().toUpperCase() === k && v && typeof v === "object") return v;
  }
  return null;
}

/** Rung 1 for this choice, or null (no rationale for it, or only leaking text). */
export function misconceptionRung(f: RemediationFacts, chosenKey: string | null): Extract<KitRung, { rung: 1 }> | null {
  const r = rationaleFor(f, chosenKey);
  if (!r) return null;
  const ref = typeof r.misconception_ref === "string" ? r.misconception_ref.trim() : "";
  const m = ref ? f.misconceptions.find((x) => x.id === ref) : undefined;
  if (m) {
    const misconception = leaks(m.misconception, f) ? null : m.misconception.trim();
    const correction = redact(m.correction, f);
    if (misconception && correction) return { rung: 1, kind: "misconception", misconception, correction };
  }
  const why = redact(r.why_wrong, f);
  return why ? { rung: 1, kind: "why_wrong", text: why } : null;
}

/** Rung 2: the explanation without the answer, else the objective; null when neither survives. */
export function hintRung(f: RemediationFacts): Extract<KitRung, { rung: 2 }> | null {
  const fromExplanation = redact(f.explanation, f);
  if (fromExplanation) return { rung: 2, kind: "hint", text: fromExplanation, from: "explanation" };
  const fromObjective = redact(f.objectiveText, f);
  return fromObjective ? { rung: 2, kind: "hint", text: fromObjective, from: "objective" } : null;
}

const mapItemsFor = (m: KitManifest, itemId: string): ManifestItem[] => m.items.filter((i) => i.availability === "available" && i.bank_item_id === itemId);

/** Rung 3: the earliest section (kit order) the map ties this item to; else the
 *  section that teaches its concept. Only AVAILABLE links (§9.6). */
export function slideRung(m: KitManifest, itemId: string): Extract<KitRung, { rung: 3 }> | null {
  const mine = mapItemsFor(m, itemId);
  const keys = new Set(mine.flatMap((i) => i.segment_ids));
  const direct = m.segments.filter((s) => keys.has(s.key)).sort((a, b) => a.k - b.k)[0];
  const seg = direct ?? mine.flatMap((i) => i.concept_ids).map((c) => segmentForConcept(m, c)).find((s) => !!s) ?? null;
  return seg ? { rung: 3, kind: "slide", k: seg.k, key: seg.key, heading: seg.heading ?? "" } : null;
}

const DETERMINISTIC = new Set(["mcq", "assertion_reason", "true_false", "fill_blank", "numerical", "match"]);

/** The objective key of a kit-map item: from its bank row when known, else
 *  from the map for an objective_ref-mapped item (concept id = objective ref). */
function keyOfMapItem(m: KitManifest, i: ManifestItem, known?: Readonly<Record<string, string | null>>): string | null {
  const id = i.bank_item_id!;
  if (known && Object.prototype.hasOwnProperty.call(known, id)) return known[id] ?? null;
  return i.method === "objective_ref" ? objectiveKey(m.article_id, i.concept_ids[0]) : null;
}

/** Rung 4's item: a different available, bank-linked item of the kit on the same
 *  objective key; else one sharing a concept. Auto-marked types first, then map order. */
export function verificationItem(m: KitManifest, itemId: string, key: string | null, opts: Pick<RemediationOptions, "exclude" | "objectiveKeys"> = {}): { itemId: string; via: "objective" | "concept" } | null {
  const exclude = new Set(opts.exclude ?? []);
  exclude.add(itemId);
  const seen = new Set<string>();
  const candidates = m.items.filter((i) => {
    if (i.availability !== "available" || !i.bank_item_id || exclude.has(i.bank_item_id) || seen.has(i.bank_item_id)) return false;
    seen.add(i.bank_item_id);
    return true;
  });
  const rank = (list: ManifestItem[]) => [...list.filter((i) => DETERMINISTIC.has(i.type)), ...list.filter((i) => !DETERMINISTIC.has(i.type))];
  if (key) {
    const same = rank(candidates.filter((i) => keyOfMapItem(m, i, opts.objectiveKeys) === key));
    if (same[0]) return { itemId: same[0].bank_item_id!, via: "objective" };
  }
  const concepts = new Set(mapItemsFor(m, itemId).flatMap((i) => i.concept_ids));
  if (concepts.size) {
    const near = rank(candidates.filter((i) => i.concept_ids.some((c) => concepts.has(c))));
    if (near[0]) return { itemId: near[0].bank_item_id!, via: "concept" };
  }
  return null;
}

function rungAt(n: RungNo, f: RemediationFacts, chosenKey: string | null, m: KitManifest, opts: RemediationOptions): KitRung | null {
  switch (n) {
    case 1:
      return misconceptionRung(f, chosenKey);
    case 2:
      return hintRung(f);
    case 3:
      return slideRung(m, f.itemId);
    case 4: {
      const v = verificationItem(m, f.itemId, f.objectiveKey, opts);
      return v ? { rung: 4, kind: "verify", itemId: v.itemId, via: v.via, item: null } : { rung: 4, kind: "verify", itemId: null, explanation: f.explanation?.trim() || null };
    }
  }
}

/**
 * The ladder's next step after a WRONG (incorrect or partial) answer.
 * Before the last attempt: the first rung of 1 → 2 → 3 not yet served and
 * available for this answer (none → an unassisted retry). On the last
 * attempt: the answer revealed, with slide(k) (if not yet served) and the
 * check question.
 */
export function remediation(f: RemediationFacts, chosenKey: string | null, attemptNo: number, m: KitManifest, opts: RemediationOptions = {}): RemediationStep {
  const served = new Set(opts.served ?? []);
  const final = attemptNo >= MAX_ATTEMPTS;
  if (!final) {
    for (const n of [1, 2, 3] as const) {
      if (served.has(n)) continue;
      const r = rungAt(n, f, chosenKey, m, opts);
      if (r) return { rungs: [r], final, reveal: null };
    }
    return { rungs: [], final, reveal: null };
  }
  const rungs: KitRung[] = [];
  if (!served.has(3)) {
    const s = rungAt(3, f, chosenKey, m, opts);
    if (s) rungs.push(s);
  }
  rungs.push(rungAt(4, f, chosenKey, m, opts)!);
  return { rungs, final, reveal: { answer: f.answerDisplay, explanation: f.explanation?.trim() || null } };
}

/** The rungs served after the earlier WRONG attempts on this item, replayed
 *  (pure) from their choices in attempt order. Its length is the number of
 *  hints the next attempt is made with (`hints_used`). */
export function ladderHistory(f: RemediationFacts, priorChoices: readonly (string | null)[], m: KitManifest, opts: Omit<RemediationOptions, "served"> = {}): RungNo[] {
  const served: RungNo[] = [];
  priorChoices.forEach((choice, i) => {
    const step = remediation(f, choice, i + 1, m, { ...opts, served });
    if (!step.final) for (const r of step.rungs) served.push(r.rung);
  });
  return served;
}

/** The option key a response chose (option text, or a bare letter), or null. */
export function chosenKeyOf(f: Pick<RemediationFacts, "type" | "options">, response: unknown): string | null {
  if (f.type === "true_false") return typeof response === "boolean" ? String(response) : null;
  if (f.type !== "mcq") return null;
  const s = String(response ?? "").trim();
  if (!s) return null;
  const byText = f.options.find((o) => o.text.trim() === s);
  if (byText) return byText.key;
  const letter = /^(?:option\s*)?([a-h])\s*[).:]?\s*$/i.exec(s);
  if (letter) {
    const o = f.options[letter[1]!.toLowerCase().charCodeAt(0) - 97];
    if (o) return o.key;
  }
  return null;
}
