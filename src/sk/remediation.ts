// SK S3 slice C — the remediation ladder (Final Plan §4.2; design decision 4:
// derived at runtime from the bank, NO model call). Pure and deterministic:
// the same item, choice, attempt and kit map always give the same rung, so
// the server can REPLAY the rungs it served earlier from the stored attempts
// instead of storing them (see ladderHistory).
//
// On a wrong answer, the next rung not yet served:
//   1  the misconception, NAMED ONLY: the chosen option's
//      `distractor_rationale[key].misconception_ref` → the article's
//      `misconception` ("It looks like you're thinking: “X”. That's not quite
//      right — have another go."); without a ref, the option's own
//      `why_wrong`. The article's CORRECTION is not shown here: the bank's
//      corrections often restate the right answer in other words (the chapter
//      5 row: "This leaves room for haemoglobin" ≈ "More space is available
//      for haemoglobin"). Only when the item has a rationale for the chosen
//      option (every mcq distractor does; other types usually not, so they
//      start at rung 2).
//   2  a hint: the explanation; else the right option's own rationale (a
//      non-why_wrong note on the answer key); else a pointer to the section
//      ("Think about what the section on <heading> says about this.").
//   3  slide(k): the kit-map section that teaches the item (its segment_ids,
//      else segmentForConcept of its concept). It carries the named
//      misconception's correction when it comes before the reveal and the
//      correction passes the leak check; otherwise the reveal carries it.
//   4  a check question: a DIFFERENT bank item of the kit on the same
//      objective_key (else the same concept); or "none — here is the
//      explanation". Offered once the tries are used up.
// A right answer at any rung ends the ladder (the caller does not ask).
// After the last attempt (MAX_ATTEMPTS) the rest of the ladder (3, 4) comes
// with the answer revealed.
//
// THE ANSWER NEVER LEAKS BEFORE THE REVEAL: every text a rung carries before
// the reveal passes `leaks()`:
//   * exact: no sentence containing the right option's text (or the fill-in
//     answer, the true/false word, a match pair's right side), and for an mcq
//     no stand-alone mention of the answer key ("B", "(B)", "option B");
//   * semantic: no sentence whose CONTENT words cover ≥ 60 % of the right
//     answer's content words (stop-words removed; lowercase; plural "s"/"es",
//     "ing" and "ed" stripped) — see contentOverlap().

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
  /** A note the bank keeps on the RIGHT option itself (not a why_wrong), if any. */
  rightRationale: string | null;
  explanation: string | null;
  misconceptions: ArticleMisconception[];
  /** topic_articles.objectives[objective_ref].text (kept for readers; not a hint source). */
  objectiveText: string | null;
  /** "<article_id>:<objective_ref>" (src/sk/objective-key.ts); null = unmapped. */
  objectiveKey: string | null;
};

export type RungNo = 1 | 2 | 3 | 4;

/** What the earlier steps did, replayed by ladderHistory. */
export type LadderState = {
  /** Rungs served before this attempt (its length = the attempt's hints_used). */
  served: RungNo[];
  /** The misconception id rung 1 named, if it named one. */
  named: string | null;
  /** The named misconception's correction was already shown (with an early slide). */
  correctionShown: boolean;
};

export type RemediationStep = {
  rungs: KitRung[];
  /** The tries are used up: the answer is revealed. */
  final: boolean;
  reveal: KitReveal | null;
  /** The ladder state after this step. */
  state: LadderState;
};

export type RemediationOptions = Partial<LadderState> & {
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

const STOP_WORDS = new Set(
  (
    "a an the is are was were be been being am of for to in on at by with from into onto about over under " +
    "and or but nor so as if than then that this these those there here it its they them their he she we you i " +
    "can could would should will shall may might must do does did done has have had not no yes " +
    "more most much many very each every all any some such only also just both either neither " +
    "which what who whom whose how why when where while one ones"
  ).split(" "),
);

/** Lowercase, then strip "ing", "ed", plural "es"/"s" (simple, symmetric). */
export function stem(w: string): string {
  const s = w.toLowerCase();
  if (s.length > 5 && s.endsWith("ing")) return s.slice(0, -3);
  if (s.length > 4 && s.endsWith("ed")) return s.slice(0, -2);
  // "es" only where English adds it (switches, boxes, glasses); "genes" → "gene", like "gene".
  if (s.length > 4 && /(?:s|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/** The stemmed content words of a text (stop-words removed). */
export function contentWords(text: string): Set<string> {
  return new Set(
    norm(text)
      .trim()
      .split(" ")
      .filter((w) => w && !STOP_WORDS.has(w))
      .map(stem),
  );
}

/** The share of `answer`'s content words that `text` also has (0 when the answer has none). */
export function contentOverlap(text: string, answer: string): number {
  const a = contentWords(answer);
  if (!a.size) return 0;
  const t = contentWords(text);
  let hit = 0;
  for (const w of a) if (t.has(w)) hit++;
  return hit / a.size;
}

export const OVERLAP_LIMIT = 0.6;

/** Would this text give the answer away (exactly, or by its content words)? */
export function leaks(text: string, f: Pick<RemediationFacts, "type" | "answerKey" | "answerTexts">): boolean {
  const n = norm(text);
  for (const a of f.answerTexts) {
    const na = norm(a);
    if (na.trim() && n.includes(na)) return true;
    if (contentOverlap(text, a) >= OVERLAP_LIMIT) return true;
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

/** The article misconception the chosen option embodies, if the bank names one. */
function misconceptionOf(f: RemediationFacts, chosenKey: string | null): ArticleMisconception | null {
  const ref = rationaleFor(f, chosenKey)?.misconception_ref;
  const id = typeof ref === "string" ? ref.trim() : "";
  return id ? (f.misconceptions.find((x) => x.id === id) ?? null) : null;
}

/** Rung 1 for this choice (and the misconception it names), or null. */
function rungOne(f: RemediationFacts, chosenKey: string | null): { rung: Extract<KitRung, { rung: 1 }>; named: string | null } | null {
  const r = rationaleFor(f, chosenKey);
  if (!r) return null;
  const m = misconceptionOf(f, chosenKey);
  if (m && !leaks(m.misconception, f)) return { rung: { rung: 1, kind: "misconception", misconception: m.misconception.trim() }, named: m.id };
  const why = redact(r.why_wrong, f);
  return why ? { rung: { rung: 1, kind: "why_wrong", text: why }, named: null } : null;
}

/** Rung 1 for this choice — the misconception NAMED, never its correction. */
export function misconceptionRung(f: RemediationFacts, chosenKey: string | null): Extract<KitRung, { rung: 1 }> | null {
  return rungOne(f, chosenKey)?.rung ?? null;
}

/** Rung 2: the explanation, else the right option's rationale (each only if it
 *  does not leak), else a pointer to the section that teaches it; null when
 *  there is none of these. */
export function hintRung(f: RemediationFacts, m?: KitManifest): Extract<KitRung, { rung: 2 }> | null {
  // Sentence by sentence first (a leaking sentence goes), then the whole: the
  // kept sentences together must not cover the answer's content words either.
  const safe = (t: string | null) => {
    const r = redact(t, f);
    return r && !leaks(r, f) ? r : null;
  };
  const fromExplanation = safe(f.explanation);
  if (fromExplanation) return { rung: 2, kind: "hint", text: fromExplanation, from: "explanation" };
  const fromRight = safe(f.rightRationale);
  if (fromRight) return { rung: 2, kind: "hint", text: fromRight, from: "rationale" };
  const s = m ? sectionFor(m, f.itemId) : null;
  return s ? { rung: 2, kind: "hint", from: "section", k: s.k, key: s.key, heading: s.heading ?? "" } : null;
}

const mapItemsFor = (m: KitManifest, itemId: string): ManifestItem[] => m.items.filter((i) => i.availability === "available" && i.bank_item_id === itemId);

function sectionFor(m: KitManifest, itemId: string) {
  const mine = mapItemsFor(m, itemId);
  const keys = new Set(mine.flatMap((i) => i.segment_ids));
  const direct = m.segments.filter((s) => keys.has(s.key)).sort((a, b) => a.k - b.k)[0];
  return direct ?? mine.flatMap((i) => i.concept_ids).map((c) => segmentForConcept(m, c)).find((s) => !!s) ?? null;
}

/** Rung 3: the earliest section (kit order) the map ties this item to; else the
 *  section that teaches its concept. Only AVAILABLE links (§9.6). */
export function slideRung(m: KitManifest, itemId: string, correction: string | null = null): Extract<KitRung, { rung: 3 }> | null {
  const seg = sectionFor(m, itemId);
  return seg ? { rung: 3, kind: "slide", k: seg.k, key: seg.key, heading: seg.heading ?? "", correction } : null;
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

function verifyRung(f: RemediationFacts, m: KitManifest, opts: RemediationOptions): Extract<KitRung, { rung: 4 }> {
  const v = verificationItem(m, f.itemId, f.objectiveKey, opts);
  return v ? { rung: 4, kind: "verify", itemId: v.itemId, via: v.via, item: null } : { rung: 4, kind: "verify", itemId: null, explanation: f.explanation?.trim() || null };
}

/**
 * The ladder's next step after a WRONG (incorrect or partial) answer.
 * Before the last attempt: the first rung of 1 → 2 → 3 not yet served and
 * available for this answer (none → an unassisted retry). On the last
 * attempt: the answer revealed, with slide(k) (if not yet served) and the
 * check question. The named misconception's correction comes with the slide
 * or the reveal, whichever is first.
 */
export function remediation(f: RemediationFacts, chosenKey: string | null, attemptNo: number, m: KitManifest, opts: RemediationOptions = {}): RemediationStep {
  const prior: LadderState = { served: [...(opts.served ?? [])], named: opts.named ?? null, correctionShown: !!opts.correctionShown };
  const served = new Set(prior.served);
  const final = attemptNo >= MAX_ATTEMPTS;
  const correctionOf = (id: string | null) => (id ? (f.misconceptions.find((x) => x.id === id)?.correction.trim() ?? null) : null);

  if (!final) {
    for (const n of [1, 2, 3] as const) {
      if (served.has(n)) continue;
      if (n === 1) {
        const one = rungOne(f, chosenKey);
        if (one) return { rungs: [one.rung], final, reveal: null, state: { ...prior, served: [...prior.served, 1], named: one.named ?? prior.named } };
      } else if (n === 2) {
        const h = hintRung(f, m);
        if (h) return { rungs: [h], final, reveal: null, state: { ...prior, served: [...prior.served, 2] } };
      } else {
        // An early slide: the correction only if it gives nothing away yet.
        const c = prior.correctionShown ? null : correctionOf(prior.named);
        const safe = c && !leaks(c, f) ? c : null;
        const s = slideRung(m, f.itemId, safe);
        if (s) return { rungs: [s], final, reveal: null, state: { ...prior, served: [...prior.served, 3], correctionShown: prior.correctionShown || !!safe } };
      }
    }
    return { rungs: [], final, reveal: null, state: prior };
  }

  // The last attempt: the answer is revealed, so the correction may be shown whole.
  const correction = prior.correctionShown ? null : correctionOf(prior.named ?? misconceptionOf(f, chosenKey)?.id ?? null);
  const rungs: KitRung[] = [];
  const slide = served.has(3) ? null : slideRung(m, f.itemId, correction);
  if (slide) rungs.push(slide);
  rungs.push(verifyRung(f, m, opts));
  const reveal: KitReveal = { answer: f.answerDisplay, explanation: f.explanation?.trim() || null, correction: slide ? null : correction };
  return { rungs, final, reveal, state: { ...prior, correctionShown: prior.correctionShown || !!correction } };
}

/** The ladder state after the earlier WRONG attempts on this item, replayed
 *  (pure) from their choices in attempt order. `served.length` is the number
 *  of hints the next attempt is made with (`hints_used`). */
export function ladderHistory(f: RemediationFacts, priorChoices: readonly (string | null)[], m: KitManifest, opts: Pick<RemediationOptions, "exclude" | "objectiveKeys"> = {}): LadderState {
  let state: LadderState = { served: [], named: null, correctionShown: false };
  priorChoices.forEach((choice, i) => {
    const step = remediation(f, choice, i + 1, m, { ...opts, ...state });
    if (!step.final) state = step.state;
  });
  return state;
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
