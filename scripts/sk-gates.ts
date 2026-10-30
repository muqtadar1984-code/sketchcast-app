/**
 * SK S5 slice E — the §8.4 leader gate runner (Final Plan 2026-10-28 §8.4;
 * SK S5 design 2026-10-29 decision 7: the School Briefing panel is retired
 * only after these gates pass on the live model).
 *
 *   node scripts/sk-gates.ts                         # scripted model, free, no network — BOTH routings + comparison table
 *   node scripts/sk-gates.ts --routing model         # scripted, model-first routing only
 *   node scripts/sk-gates.ts --model live --price-in <USD/MTok> --price-out <USD/MTok>
 *                                                    # prints the cost estimate, spends nothing
 *   SK_GATES_LIVE=1 node scripts/sk-gates.ts --model live --price-in … --price-out … [--judge live] --env-file .env.local --yes
 *                                                    # the PAID run (the founder approves it)
 *
 * It drives the REAL turn route (src/app/api/sk/shell/turn) and capabilities
 * over the seeded two-tenant fake (src/sk/gates/tenant.ts) through vitest —
 * vitest is what can stand the Supabase clients, cookies and provider in for
 * the route; this script only sets the env, guards the paid modes, prices
 * them and starts it. Runs on Node ≥ 22.6 type stripping (Node 24: by default).
 *
 * Options:
 *   --model scripted|live   scripted (default): the deterministic rules path + a scripted stub; no calls.
 *                           live: the app's real AnthropicProvider (SK_SHELL_MODEL, default claude-sonnet-5-5).
 *   --judge none|live       live: a second-model grade per item (SK_GATES_JUDGE_MODEL), reported next to the deterministic grade.
 *   --price-in / --price-out  USD per million input / output tokens. REQUIRED for any live mode; no default.
 *   --env-file <path>       load provider credentials (e.g. .env.local) for a live run.
 *   --routing rules|model|both  the Shell routing to measure (SK_ROUTING). Scripted default: both, then the
 *                           rules-vs-model comparison table (grounded, leaks, claims, wrong action, stub rounds).
 *                           Live default: rules (a live model-first run is its own paid run).
 *   --subset ci             run only the 12-item CI subset (the small live comparison). The live
 *                           estimate reads the latest scripted RULES volume: the full bank's when a
 *                           full scripted run exists (an upper bound for the subset).
 *   --report-dir <dir>      default reports/sk-gates.
 *   --yes                   actually spend (live only). Without it a live invocation prints the estimate and stops.
 *
 * Exit codes: 0 ran (the report holds the verdict) / estimate printed; 1 the run crashed; 2 refused (guard).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_TEST = "src/sk/gates/__tests__/gates.test.ts";

/**
 * PRICE_USD_PER_MTOK — the per-token price of the model a live run calls.
 * DELIBERATELY NOT HARD-CODED: it must be checked against CURRENT Anthropic /
 * Bedrock pricing for the exact model (and region, if Bedrock) before a live
 * run, and passed in as --price-in / --price-out. There is no default, and a
 * live run refuses to start without both.
 */
const PRICE_USD_PER_MTOK: { input: number | null; output: number | null } = { input: null, output: null };

type Volume = {
  turns: number;
  rulesTurns: number;
  modelTurns: number;
  modelCalls: number;
  estInputTokens: number;
  estOutputTokensExpected: number;
  estOutputTokensWorst: number;
  estInputTokensWorst: number;
  avgInputTokensPerModelCall: number;
  judgeCalls: number;
  estJudgeInputTokens: number;
  estJudgeOutputTokens: number;
  note: string;
};

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function fail(msg: string): never {
  console.error(`sk-gates: ${msg}`);
  process.exit(2);
}

type Comparison = {
  routing: string;
  items: number;
  grounded: { pass: number; n: number; rate: number };
  leakFree: { pass: number; n: number; rate: number };
  claims: number;
  wrongAction: number;
  refused: { pass: number; n: number; rate: number };
  modelCalls: number;
  modelTurns: number;
  avgRoundsPerModelTurn: number;
};

function latestComparison(dir: string, routing: string): Comparison | null {
  const p = join(ROOT, dir, `latest-scripted-${routing}.json`);
  if (!existsSync(p)) return null;
  return (JSON.parse(readFileSync(p, "utf8")) as { comparison?: Comparison }).comparison ?? null;
}

/** The rules-vs-model table, markdown (same columns as report.ts comparisonTable). */
function comparisonTable(rows: Comparison[]): string {
  const f = (r: { pass: number; n: number; rate: number }) => `${r.pass}/${r.n} (${r.rate} %)`;
  const line = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;
  return [
    line(["Routing", "Grounded pass", "Leak-free", "Action claims", "Wrong action", "Unsupported refused", "Stub model calls", "Model turns", "Avg rounds / model turn"]),
    line(["---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    ...rows.map((c) => line([c.routing, f(c.grounded), f(c.leakFree), c.claims, c.wrongAction, f(c.refused), c.modelCalls, `${c.modelTurns}/${c.items}`, c.avgRoundsPerModelTurn])),
  ].join("\n");
}

function runVitest(env: Record<string, string>): number {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", GATE_TEST], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return r.status ?? 1;
}

function latestVolume(dir: string): Volume | null {
  const p = join(ROOT, dir, "latest-scripted.json");
  if (!existsSync(p)) return null;
  return (JSON.parse(readFileSync(p, "utf8")) as { volume: Volume }).volume;
}

const usd = (tokens: number, perMTok: number) => (tokens * perMTok) / 1_000_000;
const money = (n: number) => `$${n.toFixed(2)}`;

const args = parseArgs(process.argv.slice(2));
const model = (args.model ?? "scripted") as string;
const judge = (args.judge ?? "none") as string;
const reportDir = typeof args["report-dir"] === "string" ? (args["report-dir"] as string) : "reports/sk-gates";
if (!["scripted", "live"].includes(model)) fail(`--model must be scripted or live (got ${model})`);
if (!["none", "live"].includes(judge)) fail(`--judge must be none or live (got ${judge})`);
const routingArg = (args.routing ?? (model === "live" ? "rules" : "both")) as string;
if (!["rules", "model", "both"].includes(routingArg)) fail(`--routing must be rules, model or both (got ${routingArg})`);
const routings = routingArg === "both" ? ["rules", "model"] : [routingArg];
const paid = model === "live" || judge === "live";

if (args.subset !== undefined && args.subset !== "ci") fail(`--subset must be ci (got ${String(args.subset)})`);
const baseEnv: Record<string, string> = { SK_GATES_FULL: "1", SK_GATES_REPORT_DIR: reportDir, ...(args.subset === "ci" ? { SK_GATES_SUBSET: "ci" } : {}) };

if (!paid) {
  console.log(`sk-gates: scripted run (${routings.join(" + ")} routing) — scripted model stub, no network calls.`);
  let status = 0;
  for (const routing of routings) {
    if (runVitest({ ...baseEnv, SK_GATES_MODEL: "scripted", SK_GATES_JUDGE: "none", SK_GATES_ROUTING: routing }) !== 0) status = 1;
  }
  const rows = routings.map((r) => latestComparison(reportDir, r)).filter((c): c is Comparison => !!c);
  if (rows.length) console.log(`\nsk-gates: routing comparison (scripted)\n${comparisonTable(rows)}\n`);
  process.exit(status);
}
if (routings.length !== 1) fail("a live run measures ONE routing: pass --routing rules or --routing model.");

// ── A paid mode: guard, price, estimate ─────────────────────────────────────
const priceIn = Number(args["price-in"]);
const priceOut = Number(args["price-out"]);
if (!(priceIn > 0) || !(priceOut > 0))
  fail("a live run needs --price-in and --price-out (USD per million tokens), checked against current Anthropic/Bedrock pricing for the model. There is no default.");
PRICE_USD_PER_MTOK.input = priceIn;
PRICE_USD_PER_MTOK.output = priceOut;

let volume = latestVolume(reportDir);
if (!volume) {
  console.log("sk-gates: no scripted measurement yet — running the free scripted pass first to measure the token volume.");
  if (runVitest({ ...baseEnv, SK_GATES_MODEL: "scripted", SK_GATES_JUDGE: "none" }) !== 0) process.exit(1);
  volume = latestVolume(reportDir);
  if (!volume) fail("the scripted pass wrote no volume");
}

const inP = PRICE_USD_PER_MTOK.input as number;
const outP = PRICE_USD_PER_MTOK.output as number;
const shellModel = process.env.SK_SHELL_MODEL || "claude-sonnet-5-5";
const lines: string[] = [];
let expected = 0;
let worst = 0;
if (model === "live") {
  const e = usd(volume.estInputTokens, inP) + usd(volume.estOutputTokensExpected, outP);
  const w = usd(volume.estInputTokensWorst, inP) + usd(volume.estOutputTokensWorst, outP);
  expected += e;
  worst += w;
  lines.push(
    `  model ${shellModel}: ${volume.modelTurns} of ${volume.turns} turns reach the model (${volume.rulesTurns} are rules-routed, no call)`,
    `    ${volume.modelCalls} calls × ~${volume.avgInputTokensPerModelCall} input tokens ≈ ${volume.estInputTokens} in + ~${volume.estOutputTokensExpected} out → ${money(e)}`,
    `    worst case (${volume.estInputTokensWorst} in + ${volume.estOutputTokensWorst} out) → ${money(w)}`,
  );
}
if (judge === "live") {
  const j = usd(volume.estJudgeInputTokens, inP) + usd(volume.estJudgeOutputTokens, outP);
  expected += j;
  worst += j * 2;
  lines.push(`  judge ${process.env.SK_GATES_JUDGE_MODEL || "claude-sonnet-5-5"}: ${volume.judgeCalls} calls ≈ ${volume.estJudgeInputTokens} in + ${volume.estJudgeOutputTokens} out → ${money(j)} (same prices assumed)`);
}
console.log(
  [
    "sk-gates: LIVE COST ESTIMATE",
    `  prices: $${inP}/MTok in, $${outP}/MTok out (as passed — check them against current pricing)`,
    ...lines,
    `  ESTIMATE ≈ ${money(expected)} (worst case ${money(worst)})`,
    `  ${volume.note}`,
  ].join("\n"),
);

if (process.env.SK_GATES_LIVE !== "1") fail("refusing to spend: set SK_GATES_LIVE=1 (the founder approves the paid run).");
if (args.yes !== true) {
  console.log("sk-gates: estimate only — re-run with --yes to make the paid calls.");
  process.exit(0);
}
if (typeof args["env-file"] === "string") {
  const p = resolve(ROOT, args["env-file"] as string);
  if (!existsSync(p)) fail(`--env-file ${p} not found`);
  process.loadEnvFile(p);
}
const status = runVitest({ ...baseEnv, SK_GATES_LIVE: "1", SK_GATES_MODEL: model, SK_GATES_JUDGE: judge, SK_GATES_ROUTING: routings[0] });
process.exit(status === 0 ? 0 : 1);
