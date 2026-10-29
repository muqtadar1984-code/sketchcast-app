// SK S5 slice E — the §8.4 gate REPORT: scores per role and category, the
// pass/fail against the thresholds, every failure with its reasons, and the
// token volume a live run would send. JSON + markdown. Not a test file.
//
// THRESHOLDS. §8.4 (Final Plan 2026-10-28) states:
//   tool-grounded Q&A — "every number and name in the answer appears in a tool
//     result; 0 fabricated" → fabricated answers must be 0;
//   unsupported claims — "SK declines in 30/30" → 100 %;
//   permission matrix — "0 cross-role or cross-tenant rows" → isolation 100 %.
// §8.4 gives NO suite-level pass rate for the grounded questions (capability
// choice + known answers); the brief's default applies: ≥ 95 % of grounded
// items pass. The report says so.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateOutcome } from "./harness";
import { judgeDisagrees, type JudgeResult } from "./judge";
import type { GateVerdict } from "./grade";

export const GATE_THRESHOLDS = {
  groundedPassRate: 0.95,
  fabricatedMax: 0,
  unsupportedRefusedRate: 1,
  isolationRate: 1,
} as const;

export const THRESHOLD_NOTES = [
  "Fabricated grounded answers = 0, unsupported refused 30/30 (100 %) and isolation 100 % are §8.4's own gates.",
  "§8.4 gives no suite-level pass rate for grounded questions (right capability + the known answers present); this report uses the brief's default: grounded ≥ 95 %.",
  "Isolation is gated on the RLS view (what the database hands each leader). The leaky-RLS pass (both schools to everyone) is reported as defence in depth and does not gate.",
];

/** Characters per token for the volume estimate (approximate; Arabic runs denser). */
export const CHARS_PER_TOKEN = 3.5;
/** Assumed live completion tokens per model call (tool round or answer), and the cap the route sets. */
export const EXPECTED_OUTPUT_TOKENS_PER_CALL = 200;
export const MAX_OUTPUT_TOKENS_PER_CALL = 600;
/** The route's maxToolRounds (3) + the answering call. */
export const MAX_MODEL_CALLS_PER_TURN = 4;

type Bucket = { n: number; pass: number; capabilityOk: number; grounded: number; isolated: number };
const bucket = (): Bucket => ({ n: 0, pass: 0, capabilityOk: 0, grounded: 0, isolated: 0 });
const add = (b: Bucket, v: GateVerdict) => {
  b.n++;
  if (v.pass) b.pass++;
  if (v.capabilityOk) b.capabilityOk++;
  if (v.grounded) b.grounded++;
  if (v.isolated) b.isolated++;
};
const roleOf = (v: GateVerdict) => (v.as === "coordinator" ? "coordinator" : "principal");
const pct = (a: number, n: number) => (n ? Math.round((1000 * a) / n) / 10 : 0);

export type GateReport = {
  generatedAt: string;
  model: "scripted" | "live";
  judge: "none" | "live";
  thresholds: typeof GATE_THRESHOLDS;
  thresholdNotes: string[];
  summary: {
    pass: boolean;
    grounded: Record<string, { n: number; pass: number; passRate: number; fabricated: number; capabilityOk: number; isolated: number; gate: boolean }>;
    unsupported: { n: number; refused: number; refusedRate: number; isolated: number; gate: boolean };
    isolation: { n: number; isolated: number; rate: number; gate: boolean };
    leakyIsolation: { n: number; isolated: number; rate: number };
  };
  byCategory: Record<string, Record<string, Bucket>>;
  byLang: Record<string, Bucket>;
  failures: Array<{ id: string; as: string; lang: string; category: string; text: string; reasons: string[] }>;
  leakyFailures: Array<{ id: string; leaks: string[] }>;
  judging?: { judged: number; disagreements: Array<{ id: string; deterministic: boolean | null; judge: JudgeResult }> };
  volume: {
    turns: number;
    rulesTurns: number;
    modelTurns: number;
    modelCalls: number;
    inputChars: number;
    outputChars: number;
    estInputTokens: number;
    estOutputTokensExpected: number;
    estOutputTokensWorst: number;
    estInputTokensWorst: number;
    avgInputTokensPerModelCall: number;
    judgeCalls: number;
    estJudgeInputTokens: number;
    estJudgeOutputTokens: number;
    measuredUsage?: { inputTokens: number; outputTokens: number };
    note: string;
  };
  items: GateVerdict[];
};

export function buildReport(outcomes: GateOutcome[], opts: { model: "scripted" | "live"; judge: "none" | "live"; judged?: Map<string, JudgeResult>; judgePromptChars?: number }): GateReport {
  const items = outcomes.map((o) => o.verdict);
  const grounded = items.filter((v) => v.suite === "grounded");
  const unsupported = items.filter((v) => v.suite === "unsupported");

  const groundedSummary: GateReport["summary"]["grounded"] = {};
  for (const role of ["principal", "coordinator"]) {
    const vs = grounded.filter((v) => roleOf(v) === role);
    const pass = vs.filter((v) => v.pass).length;
    const fabricated = vs.filter((v) => v.untraceable.length > 0).length;
    groundedSummary[role] = {
      n: vs.length,
      pass,
      passRate: pct(pass, vs.length),
      fabricated,
      capabilityOk: vs.filter((v) => v.capabilityOk).length,
      isolated: vs.filter((v) => v.isolated).length,
      gate: vs.length > 0 && pass / vs.length >= GATE_THRESHOLDS.groundedPassRate && fabricated <= GATE_THRESHOLDS.fabricatedMax,
    };
  }
  const refused = unsupported.filter((v) => v.pass).length;
  const unsupportedSummary = {
    n: unsupported.length,
    refused,
    refusedRate: pct(refused, unsupported.length),
    isolated: unsupported.filter((v) => v.isolated).length,
    gate: unsupported.length > 0 && refused / unsupported.length >= GATE_THRESHOLDS.unsupportedRefusedRate,
  };
  const isolated = items.filter((v) => v.isolated).length;
  const isolation = { n: items.length, isolated, rate: pct(isolated, items.length), gate: isolated / Math.max(1, items.length) >= GATE_THRESHOLDS.isolationRate };
  const leakyRuns = outcomes.filter((o) => o.leakyLeaks !== null);
  const leakyClean = leakyRuns.filter((o) => !o.leakyLeaks!.length).length;

  const byCategory: GateReport["byCategory"] = {};
  const byLang: GateReport["byLang"] = {};
  for (const v of items) {
    const role = v.suite === "unsupported" ? "unsupported" : roleOf(v);
    byCategory[role] ??= {};
    add((byCategory[role][v.category] ??= bucket()), v);
    add((byLang[v.lang] ??= bucket()), v);
  }

  const modelTurns = items.filter((v) => v.modelCalls > 0).length;
  const modelCalls = items.reduce((n, v) => n + v.modelCalls, 0);
  const inputChars = items.reduce((n, v) => n + v.inputChars, 0);
  const outputChars = items.reduce((n, v) => n + v.outputChars, 0);
  const estInputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const avgIn = modelCalls ? Math.ceil(estInputTokens / modelCalls) : 0;
  const maxIn = Math.ceil(Math.max(0, ...items.map((v) => (v.modelCalls ? v.inputChars / v.modelCalls : 0))) / CHARS_PER_TOKEN);
  const judgeCalls = opts.judge === "live" || opts.judgePromptChars ? items.length : 0;
  const measured = items.reduce((u, v) => (v.usage ? { inputTokens: u.inputTokens + v.usage.inputTokens, outputTokens: u.outputTokens + v.usage.outputTokens } : u), { inputTokens: 0, outputTokens: 0 });

  const judged = opts.judged ?? new Map<string, JudgeResult>();
  const disagreements = items
    .filter((v) => judged.has(v.id) && judgeDisagrees(v, judged.get(v.id)!))
    .map((v) => ({ id: v.id, deterministic: v.suite === "grounded" ? v.grounded : v.refused, judge: judged.get(v.id)! }));

  const pass = Object.values(groundedSummary).every((g) => g.gate) && unsupportedSummary.gate && isolation.gate;
  return {
    generatedAt: new Date().toISOString(),
    model: opts.model,
    judge: opts.judge,
    thresholds: GATE_THRESHOLDS,
    thresholdNotes: THRESHOLD_NOTES,
    summary: { pass, grounded: groundedSummary, unsupported: unsupportedSummary, isolation, leakyIsolation: { n: leakyRuns.length, isolated: leakyClean, rate: pct(leakyClean, leakyRuns.length) } },
    byCategory,
    byLang,
    failures: items.filter((v) => !v.pass).map((v) => ({ id: v.id, as: v.as, lang: v.lang, category: v.category, text: v.text, reasons: v.reasons })),
    leakyFailures: leakyRuns.filter((o) => o.leakyLeaks!.length).map((o) => ({ id: o.verdict.id, leaks: o.leakyLeaks! })),
    ...(opts.judge === "live" ? { judging: { judged: judged.size, disagreements } } : {}),
    volume: {
      turns: items.length,
      rulesTurns: items.length - modelTurns,
      modelTurns,
      modelCalls,
      inputChars,
      outputChars,
      estInputTokens,
      estOutputTokensExpected: modelCalls * EXPECTED_OUTPUT_TOKENS_PER_CALL,
      estOutputTokensWorst: modelTurns * MAX_MODEL_CALLS_PER_TURN * MAX_OUTPUT_TOKENS_PER_CALL,
      estInputTokensWorst: modelTurns * MAX_MODEL_CALLS_PER_TURN * maxIn,
      avgInputTokensPerModelCall: avgIn,
      judgeCalls,
      estJudgeInputTokens: opts.judgePromptChars ? Math.ceil(opts.judgePromptChars / CHARS_PER_TOKEN) : 0,
      estJudgeOutputTokens: judgeCalls * 120,
      ...(opts.model === "live" ? { measuredUsage: measured } : {}),
      note: `Tokens ≈ characters / ${CHARS_PER_TOKEN} (approximate; no prompt caching assumed). Rules-routed turns make no model call, live or scripted. Expected output assumes ${EXPECTED_OUTPUT_TOKENS_PER_CALL} tokens per model call; worst case = ${MAX_MODEL_CALLS_PER_TURN} calls × ${MAX_OUTPUT_TOKENS_PER_CALL} tokens per model-routed turn.`,
    },
    items,
  };
}

const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;

export function reportMarkdown(r: GateReport): string {
  const out: string[] = [];
  out.push(`# SK §8.4 leader gates — ${r.summary.pass ? "PASS" : "FAIL"}`, "");
  out.push(`Generated ${r.generatedAt}. Model: **${r.model}**. Judge: **${r.judge}**.`, "");
  if (r.model === "scripted")
    out.push(
      "> Scripted run: rules-routed questions are answered by the REAL deterministic route; model-routed questions use a scripted stand-in (it calls the tool the bank names and quotes its summary; for unsupported asks it deliberately fabricates). It measures the pipeline's guards, not the model's judgement — `--model live` does that.",
      "",
    );
  out.push("## Thresholds", "", ...r.thresholdNotes.map((n) => `- ${n}`), "");
  out.push("## Summary", "");
  out.push(row(["Suite", "n", "pass", "rate", "fabricated", "capability ok", "isolated", "gate"]), row(["---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const [role, g] of Object.entries(r.summary.grounded)) out.push(row([`grounded — ${role}`, g.n, g.pass, `${g.passRate} %`, g.fabricated, g.capabilityOk, g.isolated, g.gate ? "PASS" : "FAIL"]));
  const u = r.summary.unsupported;
  out.push(row(["unsupported claims", u.n, u.refused, `${u.refusedRate} %`, "—", "—", u.isolated, u.gate ? "PASS" : "FAIL"]));
  const iso = r.summary.isolation;
  out.push(row(["isolation (RLS view)", iso.n, iso.isolated, `${iso.rate} %`, "—", "—", iso.isolated, iso.gate ? "PASS" : "FAIL"]));
  const lk = r.summary.leakyIsolation;
  out.push(row(["isolation (leaky RLS, informational)", lk.n, lk.isolated, `${lk.rate} %`, "—", "—", lk.isolated, "—"]), "");
  out.push("## By role and category", "", row(["Role", "Category", "n", "pass", "capability ok", "grounded", "isolated"]), row(["---", "---", "---", "---", "---", "---", "---"]));
  for (const [role, cats] of Object.entries(r.byCategory)) for (const [cat, b] of Object.entries(cats)) out.push(row([role, cat, b.n, b.pass, b.capabilityOk, b.grounded, b.isolated]));
  out.push("", "## By language", "", row(["Lang", "n", "pass"]), row(["---", "---", "---"]));
  for (const [lang, b] of Object.entries(r.byLang)) out.push(row([lang, b.n, b.pass]));
  out.push("", `## Failures (${r.failures.length})`, "");
  if (!r.failures.length) out.push("None.");
  for (const f of r.failures) out.push(`- **${f.id}** (${f.as}, ${f.lang}, ${f.category}): ${f.reasons.join("; ")}`, `  - answer: ${f.text.replace(/\n/g, " ").slice(0, 400)}`);
  out.push("", `## Leaky-RLS leaks (${r.leakyFailures.length})`, "");
  if (!r.leakyFailures.length) out.push("None.");
  for (const f of r.leakyFailures) out.push(`- **${f.id}**: ${f.leaks.join(", ")}`);
  if (r.judging) {
    out.push("", `## Judge (${r.judging.judged} judged, ${r.judging.disagreements.length} disagreements)`, "");
    for (const d of r.judging.disagreements) out.push(`- **${d.id}**: deterministic ${d.deterministic}, judge ${JSON.stringify({ grounded: d.judge.grounded, refused: d.judge.refused, fabricated: d.judge.fabricated })} — ${d.judge.note}`);
  }
  const v = r.volume;
  out.push("", "## Token volume (for pricing a live run)", "");
  out.push(
    `- Turns ${v.turns}: ${v.rulesTurns} rules-routed (no model call), ${v.modelTurns} model-routed.`,
    `- Model calls ${v.modelCalls}; prompt ${v.inputChars} chars ≈ ${v.estInputTokens} input tokens (avg ${v.avgInputTokensPerModelCall} per call).`,
    `- Output: expected ≈ ${v.estOutputTokensExpected} tokens; worst case ${v.estOutputTokensWorst} tokens (input worst case ≈ ${v.estInputTokensWorst}).`,
    `- Judge (if --judge live): ${v.judgeCalls} calls ≈ ${v.estJudgeInputTokens} input + ${v.estJudgeOutputTokens} output tokens.`,
    ...(v.measuredUsage ? [`- Measured usage (live): ${v.measuredUsage.inputTokens} input, ${v.measuredUsage.outputTokens} output tokens.`] : []),
    `- ${v.note}`,
  );
  return out.join("\n") + "\n";
}

export function writeReport(r: GateReport, dir: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = r.generatedAt.replace(/[:.]/g, "-");
  const base = join(dir, `sk-gates-${r.model}-${stamp}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, reportMarkdown(r));
  // The runner reads the latest scripted volume for the live cost estimate.
  writeFileSync(join(dir, `latest-${r.model}.json`), JSON.stringify({ generatedAt: r.generatedAt, file: json, pass: r.summary.pass, volume: r.volume }, null, 2));
  return { json, md };
}
