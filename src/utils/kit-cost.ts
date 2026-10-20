// Average cost per KIT for the console Overview (founder, 2026-10-20: pricing
// has to be checked against real cost, continuously). Pure: rows in, numbers
// out — the page fetches, this folds, the tests pin the arithmetic.
//
// Three kinds of kit, costed apart because they cost apart:
//
//   * CLIENT kits — what teachers and parents generate from their own books:
//     generations WITHOUT params.catalogue, one kit per
//     (book_id, chapter_ref, part, language). Catalogue copies a teacher
//     adopted (params.catalogue_ref) were never generated and are skipped.
//   * ENGLISH catalogue kits — topic_kits rows with no source_kit_id: the
//     presentation generation plus every id in doc_generation_ids.
//   * TRANSLATED catalogue kits — topic_kits rows WITH a source_kit_id. Their
//     render, deck and bank-drawn worksheet make no model calls; the text
//     spend lives on the kit_translate job, tied to the kit it built by
//     jobs.stage.kit_id. A translate run whose kit was later replaced (a
//     re-run, a failed attempt) is real spend with no kit to carry it, so it
//     is reported as its own line instead of inflating the survivor.
//
// Per-topic extras (topic_article, topic_questions jobs) are shared by every
// kit of a topic, in every language, so they are their own line too.
//
// WHAT jobs.usage HOLDS. Today: TEXT tokens only (calls, input_tokens,
// output_tokens, cost_usd). The worker's "record true cost" change
// (sketchcast-ai feat/jobs-usage-real-cost) adds by_model ("<backend>:<model>"
// → {backend, model, cost_usd}), images_usd, tts_usd and total_usd. Every
// reader below takes the richer field when the row has it and falls back
// otherwise, so the page goes all-in and the provider split goes exact on
// its own once that lands — no change here.

import { OBSERVER_JOB_TYPES } from "./builder-job";

// ── row shapes (the subset the page selects) ────────────────────────────────

export type ModelSpend = { backend?: string | null; model?: string | null; cost_usd?: number | null };

export type Usage = {
  cost_usd?: number | null;
  images_usd?: number | null;
  tts_usd?: number | null;
  total_usd?: number | null;
  by_model?: Record<string, ModelSpend> | null;
};

export type CostJob = {
  id: string;
  generation_id: string | null;
  type: string | null;
  status: string;
  usage: Usage | null;
  created_at: string;
  /** params->>topic_id (topic_article / topic_questions). */
  topic_id?: string | null;
  /** stage->>kit_id — the kit a kit_translate run built. */
  stage_kit_id?: string | null;
};

export type CostGen = {
  id: string;
  owner_id: string;
  kind: string | null;
  book_id: string | null;
  chapter_ref: string | null;
  created_at: string;
  /** params->>part, ->>language, ->>catalogue, ->>catalogue_ref, ->>coverage_model */
  part: string | null;
  language: string | null;
  catalogue: string | null;
  catalogue_ref: string | null;
  coverage_model: string | null;
};

export type TopicKitRow = {
  id: string;
  topic_id: string;
  language: string;
  source_kit_id: string | null;
  status: string;
  created_at: string;
  presentation_generation_id: string | null;
  doc_generation_ids: Record<string, string> | null;
};

// ── constants ───────────────────────────────────────────────────────────────

/** The pieces of a full client kit. A kit missing any of them is "partial". */
export const FULL_KIT_KINDS = ["presentation", "deck", "worksheet", "activity", "case_study", "lesson_plan"] as const;

/** jobs.usage is trustworthy from here on. Until the worker's per-generation
 * usage ledger (worker #222, 2026-10-14 18:16 UTC) a job recorded only the
 * calls of the client object that finished it: one or two calls, a fraction
 * of a cent, for a lesson that cost tens of cents (client Claude videos
 * averaged $0.04 before, $0.65 after); catalogue videos and decks recorded
 * nothing. Kits begun earlier are excluded, and said so. */
export const USAGE_TRACKED_FROM = "2026-10-15T00:00:00Z";

/** Catalogue text moved from Gemini to Claude (Bedrock) at this instant
 * (worker LLM_BACKEND / CATALOGUE_TEXT_PROVIDER cutover). Used only for rows
 * that carry no by_model and no recorded model. */
export const CATALOGUE_CLAUDE_FROM = "2026-10-18T08:33:00Z";

/** Client lessons in these languages are written by Claude (script routing);
 * every other language by Gemini. Same fallback rule as above. */
export const CLAUDE_LANGUAGES: ReadonlySet<string> = new Set(["ar", "ur", "ms-arab"]);

const FINISHED = new Set(["done", "error"]);
const TRACKING_REASON = "before usage tracking (15 Oct)";
const beforeTracking = (iso: string) => Date.parse(iso) < Date.parse(USAGE_TRACKED_FROM);

// ── window ──────────────────────────────────────────────────────────────────

export const COST_WINDOWS = [30, 90] as const;

export type CostWindow = { startMs: number; days: number | null; since: string | null; label: string };

/** ?costdays=30|90 or ?costsince=YYYY-MM-DD (UTC). Junk falls back to 30 days;
 * a since-date in the future is treated as absent. */
export function parseCostWindow(sp: { costdays?: string; costsince?: string }, now: Date): CostWindow {
  const since = sp.costsince?.trim();
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const t = Date.parse(`${since}T00:00:00Z`);
    if (Number.isFinite(t) && t <= now.getTime()) return { startMs: t, days: null, since, label: `since ${since}` };
  }
  const d = Number(sp.costdays);
  const days = (COST_WINDOWS as readonly number[]).includes(d) ? d : 30;
  return { startMs: now.getTime() - days * 86_400_000, days, since: null, label: `last ${days} days` };
}

// ── per-job money ───────────────────────────────────────────────────────────

export type Provider = "Claude" | "Gemini" | "Other";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A job's recorded spend, or null when the row recorded none. `allIn` is
 * true only when the row says what pictures and narration cost too. */
export function jobSpend(u: Usage | null | undefined): { usd: number; textUsd: number; allIn: boolean } | null {
  if (!u || typeof u !== "object") return null;
  const text = num(u.cost_usd);
  const total = num(u.total_usd);
  const images = num(u.images_usd);
  const tts = num(u.tts_usd);
  if (text === null && total === null) return null;
  const allIn = total !== null || (images !== null && tts !== null);
  const usd = total ?? (text ?? 0) + (images ?? 0) + (tts ?? 0);
  return { usd, textUsd: text ?? usd - (images ?? 0) - (tts ?? 0), allIn };
}

/** Which provider a backend/model name belongs to. */
export function providerOf(backend: string | null | undefined, model: string | null | undefined): Provider | null {
  const m = (model ?? "").toLowerCase();
  const b = (backend ?? "").toLowerCase();
  if (m.startsWith("claude") || m.includes("anthropic") || b === "anthropic" || b === "bedrock") return "Claude";
  if (m.startsWith("gemini") || b === "vertex" || b === "gemini") return "Gemini";
  if (!m && !b) return null;
  return "Other";
}

/** Text spend by provider for one job. Exact when the row carries by_model;
 * otherwise the piece's recorded model (generations.params.coverage_model),
 * and failing that the documented routing. `inferred` says which. */
export function jobProviders(
  job: CostJob,
  ctx: { catalogue: boolean; language: string | null; coverageModel: string | null },
): { split: Map<Provider, number>; inferred: boolean } {
  const spend = jobSpend(job.usage);
  const split = new Map<Provider, number>();
  if (!spend) return { split, inferred: false };
  const byModel = job.usage?.by_model;
  if (byModel && typeof byModel === "object" && Object.keys(byModel).length > 0) {
    for (const [key, entry] of Object.entries(byModel)) {
      const c = num(entry?.cost_usd) ?? 0;
      const [kb, km] = key.split(":", 2);
      const p = providerOf(entry?.backend ?? kb, entry?.model ?? km) ?? "Other";
      split.set(p, (split.get(p) ?? 0) + c);
    }
    return { split, inferred: false };
  }
  let p = providerOf(null, ctx.coverageModel);
  if (!p) {
    p = ctx.catalogue
      ? Date.parse(job.created_at) >= Date.parse(CATALOGUE_CLAUDE_FROM) ? "Claude" : "Gemini"
      : CLAUDE_LANGUAGES.has((ctx.language ?? "").toLowerCase()) ? "Claude" : "Gemini";
  }
  split.set(p, spend.textUsd);
  return { split, inferred: true };
}

// ── report ──────────────────────────────────────────────────────────────────

export type PieceStat = { kind: string; n: number; avgUsd: number };
export type ProviderStat = { provider: Provider | "Mixed"; kits: number; avgUsd: number };

export type GroupStats = {
  /** Kits created in the window (costed + excluded). */
  kits: number;
  costed: number;
  excluded: { reason: string; n: number }[];
  totalUsd: number;
  avgUsd: number | null;
  medianUsd: number | null;
  /** Average per piece kind, over pieces that recorded spend. */
  pieces: PieceStat[];
  /** Costed kits by who wrote their text — a kit with spend on both is Mixed. */
  providers: ProviderStat[];
  /** True when any provider attribution came from routing, not by_model. */
  providersInferred: boolean;
  /** Costed kits whose every costed job also recorded images and TTS. */
  allIn: number;
  /** Client only: kits holding all six FULL_KIT_KINDS. */
  fullKits?: number;
  /** Client only: Σ per-piece averages over FULL_KIT_KINDS — what a full kit
   * costs when kits as generated are a mix of full and partial. */
  fullKitEstimateUsd?: number | null;
};

export type ExtraStat = { jobs: number; costed: number; totalUsd: number; avgUsd: number | null };

export type KitCostReport = {
  client: GroupStats;
  english: GroupStats;
  translated: GroupStats;
  extras: {
    articles: ExtraStat;
    questions: ExtraStat;
    /** Distinct topics the costed extras belong to. */
    topics: number;
    perTopicUsd: number | null;
    /** kit_translate runs whose kit no longer exists (re-run or failed). */
    orphanTranslate: ExtraStat;
  };
};

type Piece = { kind: string; usd: number | null; allIn: boolean; running: boolean; finishedWithoutUsage: boolean; anyDone: boolean };
type Kit = { pieces: Piece[]; split: Map<Provider, number>; inferred: boolean; exclude: string | null };

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function addSplit(into: Map<Provider, number>, from: Map<Provider, number>) {
  for (const [p, c] of from) into.set(p, (into.get(p) ?? 0) + c);
}

/** One piece (generation, or the translate pseudo-piece) from its jobs. */
function piece(
  kind: string,
  jobs: readonly CostJob[],
  ctx: { catalogue: boolean; language: string | null; coverageModel: string | null },
  kit: { split: Map<Provider, number>; inferred: boolean },
): Piece {
  let usd: number | null = null;
  let allIn = true;
  let running = false;
  let anyDone = false;
  for (const j of jobs) {
    if (!FINISHED.has(j.status)) running = true;
    if (j.status === "done") anyDone = true;
    const s = jobSpend(j.usage);
    if (!s) continue;
    usd = (usd ?? 0) + s.usd;
    allIn &&= s.allIn;
    const pv = jobProviders(j, ctx);
    addSplit(kit.split, pv.split);
    kit.inferred ||= pv.inferred;
  }
  return { kind, usd, allIn: usd !== null && allIn, running, anyDone, finishedWithoutUsage: anyDone && usd === null };
}

function summarise(kits: readonly Kit[], full?: { fullKits: number }): GroupStats {
  const costed = kits.filter((k) => !k.exclude);
  const reasons = new Map<string, number>();
  for (const k of kits) if (k.exclude) reasons.set(k.exclude, (reasons.get(k.exclude) ?? 0) + 1);
  const totals = costed.map((k) => k.pieces.reduce((a, p) => a + (p.usd ?? 0), 0));
  const totalUsd = totals.reduce((a, b) => a + b, 0);

  const byKind = new Map<string, { n: number; usd: number }>();
  for (const k of costed)
    for (const p of k.pieces) {
      if (p.usd === null) continue;
      const row = byKind.get(p.kind) ?? { n: 0, usd: 0 };
      row.n++;
      row.usd += p.usd;
      byKind.set(p.kind, row);
    }
  const order = (kind: string) => {
    const i = (FULL_KIT_KINDS as readonly string[]).indexOf(kind);
    return i === -1 ? 100 : i;
  };
  const pieces = [...byKind.entries()]
    .map(([kind, r]) => ({ kind, n: r.n, avgUsd: r.usd / r.n }))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.kind.localeCompare(b.kind));

  const byProv = new Map<Provider | "Mixed", { kits: number; usd: number }>();
  costed.forEach((k, i) => {
    const live = [...k.split.entries()].filter(([, c]) => c > 0).map(([p]) => p);
    const key: Provider | "Mixed" = live.length === 1 ? live[0] : live.length === 0 ? "Other" : "Mixed";
    const row = byProv.get(key) ?? { kits: 0, usd: 0 };
    row.kits++;
    row.usd += totals[i];
    byProv.set(key, row);
  });
  const providers = [...byProv.entries()]
    .map(([provider, r]) => ({ provider, kits: r.kits, avgUsd: r.usd / r.kits }))
    .sort((a, b) => b.kits - a.kits);

  const out: GroupStats = {
    kits: kits.length,
    costed: costed.length,
    excluded: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    totalUsd,
    avgUsd: costed.length ? totalUsd / costed.length : null,
    medianUsd: median(totals),
    pieces,
    providers,
    providersInferred: costed.some((k) => k.inferred),
    allIn: costed.filter((k) => k.pieces.every((p) => p.usd === null || p.allIn)).length,
  };
  if (full) {
    out.fullKits = full.fullKits;
    const avgs = FULL_KIT_KINDS.map((kind) => byKind.get(kind));
    out.fullKitEstimateUsd = avgs.every(Boolean) ? avgs.reduce((a, r) => a + r!.usd / r!.n, 0) : null;
  }
  return out;
}

function extraStat(jobs: readonly CostJob[]): ExtraStat {
  const costs = jobs.map((j) => jobSpend(j.usage)).filter((s): s is NonNullable<typeof s> => s !== null);
  const totalUsd = costs.reduce((a, s) => a + s.usd, 0);
  return { jobs: jobs.length, costed: costs.length, totalUsd, avgUsd: costs.length ? totalUsd / costs.length : null };
}

/**
 * The report for one window. `gens` and `jobs` may reach back further than
 * the window (a kit is dated by its FIRST piece, a job by its own row); only
 * kits and extras that START inside the window are counted. `excludedOwners`
 * are the page's demo / staff / metrics-excluded accounts — their own-book
 * kits are testing, not clients.
 */
export function kitCostReport(input: {
  gens: readonly CostGen[];
  jobs: readonly CostJob[];
  topicKits: readonly TopicKitRow[];
  excludedOwners: ReadonlySet<string>;
  windowStartMs: number;
}): KitCostReport {
  const { gens, topicKits, excludedOwners, windowStartMs } = input;
  const inWindow = (iso: string) => Date.parse(iso) >= windowStartMs;
  const jobs = input.jobs.filter((j) => !(j.type && OBSERVER_JOB_TYPES.has(j.type)));

  const jobsByGen = new Map<string, CostJob[]>();
  for (const j of jobs) if (j.generation_id) (jobsByGen.get(j.generation_id) ?? jobsByGen.set(j.generation_id, []).get(j.generation_id)!).push(j);
  const genById = new Map(gens.map((g) => [g.id, g]));

  // ── client kits ──
  const groups = new Map<string, CostGen[]>();
  for (const g of gens) {
    if (g.catalogue || g.catalogue_ref) continue;
    if (excludedOwners.has(g.owner_id)) continue;
    const key = `${g.book_id ?? ""}|${g.chapter_ref ?? ""}|${g.part ?? "0"}|${g.language ?? ""}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(g);
  }
  const clientKits: Kit[] = [];
  let fullKits = 0;
  for (const members of groups.values()) {
    const first = members.reduce((a, g) => (Date.parse(g.created_at) < Date.parse(a) ? g.created_at : a), members[0].created_at);
    if (!inWindow(first)) continue;
    const kit: Kit = { pieces: [], split: new Map(), inferred: false, exclude: null };
    for (const g of members) {
      kit.pieces.push(piece(g.kind ?? "presentation", jobsByGen.get(g.id) ?? [], {
        catalogue: false, language: g.language, coverageModel: g.coverage_model,
      }, kit));
    }
    const kinds = new Set(members.map((g) => g.kind ?? "presentation"));
    if (FULL_KIT_KINDS.every((k) => kinds.has(k))) fullKits++;
    if (beforeTracking(first)) kit.exclude = TRACKING_REASON;
    else if (kit.pieces.some((p) => p.running)) kit.exclude = "still generating";
    else if (!kit.pieces.some((p) => p.anyDone)) kit.exclude = "nothing finished";
    else if (kit.pieces.some((p) => p.finishedWithoutUsage)) kit.exclude = "a finished piece recorded no usage";
    clientKits.push(kit);
  }

  // ── catalogue kits ──
  const kitIds = new Set(topicKits.map((k) => k.id));
  const translateByKit = new Map<string, CostJob[]>();
  const orphanTranslate: CostJob[] = [];
  for (const j of jobs) {
    if (j.type !== "kit_translate") continue;
    if (j.stage_kit_id && kitIds.has(j.stage_kit_id)) {
      (translateByKit.get(j.stage_kit_id) ?? translateByKit.set(j.stage_kit_id, []).get(j.stage_kit_id)!).push(j);
    } else if (inWindow(j.created_at)) {
      orphanTranslate.push(j);
    }
  }
  const english: Kit[] = [];
  const translated: Kit[] = [];
  for (const tk of topicKits) {
    if (!inWindow(tk.created_at)) continue;
    const kit: Kit = { pieces: [], split: new Map(), inferred: false, exclude: null };
    const slots: [string, string | null][] = [["presentation", tk.presentation_generation_id], ...Object.entries(tk.doc_generation_ids ?? {})];
    let presentation: Piece | null = null;
    for (const [slot, gid] of slots) {
      if (!gid) continue;
      const g = genById.get(gid);
      const p = piece(slot, jobsByGen.get(gid) ?? [], {
        catalogue: true, language: tk.language, coverageModel: g?.coverage_model ?? null,
      }, kit);
      if (slot === "presentation") presentation = p;
      kit.pieces.push(p);
    }
    let anchored = presentation?.usd != null;
    if (tk.source_kit_id) {
      const tr = translateByKit.get(tk.id) ?? [];
      if (tr.length) {
        const p = piece("translation", tr, { catalogue: true, language: tk.language, coverageModel: null }, kit);
        kit.pieces.push(p);
        anchored ||= p.usd !== null;
      }
    }
    if (beforeTracking(tk.created_at)) kit.exclude = TRACKING_REASON;
    else if (kit.pieces.some((p) => p.running)) kit.exclude = "still generating";
    else if (!anchored) kit.exclude = tk.source_kit_id ? "no translation spend recorded" : "video recorded no usage";
    (tk.source_kit_id ? translated : english).push(kit);
  }

  // ── per-topic extras ──
  const windowJobs = jobs.filter((j) => inWindow(j.created_at));
  const articles = windowJobs.filter((j) => j.type === "topic_article");
  const questions = windowJobs.filter((j) => j.type === "topic_questions");
  const a = extraStat(articles);
  const q = extraStat(questions);
  const topics = new Set(
    [...articles, ...questions].filter((j) => jobSpend(j.usage) && j.topic_id).map((j) => j.topic_id as string),
  );

  return {
    client: summarise(clientKits, { fullKits }),
    english: summarise(english),
    translated: summarise(translated),
    extras: {
      articles: a,
      questions: q,
      topics: topics.size,
      perTopicUsd: topics.size ? (a.totalUsd + q.totalUsd) / topics.size : null,
      orphanTranslate: extraStat(orphanTranslate),
    },
  };
}
