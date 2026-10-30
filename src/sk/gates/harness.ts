// SK S5 slice E — the §8.4 gate HARNESS: drive one bank item through the
// REAL /api/sk/shell/turn route (gate → Context → rules → leader capability
// or the model with the registry's tools → grounding → events) over the
// seeded two-tenant fake, then grade it. Not a test file.
//
// The module wiring (the Supabase clients, cookies, the provider, the
// recording registry) is vi.mock'ed by the test file that calls this — vi.mock
// only hoists in a test file — and handed in as `GateHooks`.

import { fakeAuditLog, withAuditLog } from "@/sk/shell/__tests__/audit-log-fake";
import { GATE_CLOCK, GATE_USERS, forbiddenFor, gateAdmin, gateSession, gateTables, viewFor, type GateView } from "./tenant";
import { answerText, gradeItem, type GateEvent, type GateRun, type GateToolResult, type GateVerdict } from "./grade";
import type { GateItem, GateScript } from "./types";

/** 2026-10-30: the Shell routing a gate run measures (SK_ROUTING). */
export type GateRouting = "rules" | "model";

export type GateHooks = {
  /** Sign the next request in as this session (createClient). */
  setSession: (session: unknown) => void;
  setAdmin: (admin: unknown) => void;
  setHat: (hat: string | undefined) => void;
  /** Reset the per-turn recorders and arm the scripted model with this item. */
  begin: (item: GateItem) => void;
  /** What the turn recorded: capability results and model call sizes. */
  collect: () => { results: GateToolResult[]; calls: Array<{ inputChars: number; outputChars: number }>; usage?: { inputTokens: number; outputTokens: number } };
};

export type TurnPost = (req: Request) => Promise<Response>;

/** The env the gates run under: SK on for the seeded leaders, school
 *  analytics / timetable / calendar / notices / hats on. */
export const GATE_ENV: Record<string, string> = {
  FEATURE_SK: "true",
  SK_ROLES: "teacher,school_admin",
  SK_ALLOWED_EMAILS: Object.values(GATE_USERS)
    .map((u) => u.email)
    .join(","),
  SK_SHELL_SECRET: "sk-gates-secret-of-adequate-length-0001",
  FEATURE_ROLE_HATS: "true",
  FEATURE_DIARY: "true",
  FEATURE_SCHOOL_ANALYTICS: "true",
  FEATURE_TIMETABLE: "true",
  FEATURE_CALENDAR: "true",
  FEATURE_NOTICES: "true",
};
/** Env the gates clear so a developer's shell cannot change the route's path. */
export const GATE_ENV_CLEARED = ["SK_ALLOWED_STUDENTS_OF", "SK_SHELL_CONSUMER", "SK_AUDIT", "FEATURE_PARENT_PORTAL", "FEATURE_SK_SHELL_ALL_SCHOOLS", "FEATURE_CATALOGUE_TAB"];

export function applyGateEnv(): () => void {
  const keys = [...Object.keys(GATE_ENV), ...GATE_ENV_CLEARED];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of GATE_ENV_CLEARED) delete process.env[k];
  Object.assign(process.env, GATE_ENV);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function readEvents(res: Response): Promise<GateEvent[]> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return [{ type: "error", status: res.status, message: text.slice(0, 300) }];
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as GateEvent);
}

let seq = 0;

/** One item, one turn, one fresh session (and a fresh 60/day audit log). */
export async function runGateTurn(item: GateItem, post: TurnPost, hooks: GateHooks, view: GateView): Promise<GateRun> {
  const who = GATE_USERS[item.as];
  hooks.begin(item);
  hooks.setHat(who.hat);
  hooks.setSession(withAuditLog(gateSession(who, viewFor(who, view, gateTables())), fakeAuditLog({ user: who.id })));
  hooks.setAdmin(gateAdmin());
  const turnId = `5e5e5e5e-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const req = new Request("http://gates/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId, text: item.text, modality: "text", collector: { path: "/dashboard/school", locale: item.lang, clock: GATE_CLOCK } }),
  });
  const events = await readEvents(await post(req));
  const { results, calls, usage } = hooks.collect();
  return {
    events,
    results,
    modelCalls: calls.length,
    inputChars: calls.reduce((n, c) => n + c.inputChars, 0),
    outputChars: calls.reduce((n, c) => n + c.outputChars, 0),
    ...(usage ? { usage } : {}),
  };
}

export type GateOutcome = { verdict: GateVerdict; leakyLeaks: string[] | null; results: GateToolResult[] };

/** Run `fn` with SK_ROUTING set to `routing`, restoring it after. */
async function withRouting<T>(routing: GateRouting, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SK_ROUTING;
  process.env.SK_ROUTING = routing;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SK_ROUTING;
    else process.env.SK_ROUTING = saved;
  }
}

/**
 * Model routing, an item the bank answers by RULES (no script): the scripted
 * stand-in must call what an honest model would — the capability (and the
 * arguments) the rules chose for the same words, then quote its summary.
 * Found by running the item once under rules routing; a rules answer that
 * ran no capability (a fixed line) is said as is.
 */
export async function scriptFromRules(item: GateItem, post: TurnPost, hooks: GateHooks): Promise<GateScript> {
  const run = await withRouting("rules", () => runGateTurn({ ...item, scripted: undefined }, post, hooks, "rls"));
  const first = run.results[0];
  return first ? { calls: [{ name: first.name, args: first.args }], say: "{summary}" } : { say: answerText(run.events) || "I have nothing on that." };
}

/** Run and grade every item on the RLS view; optionally re-run each on the
 *  LEAKY view (both schools to everyone) for the isolation-only pass. */
export async function runGates(
  items: GateItem[],
  post: TurnPost,
  hooks: GateHooks,
  opts: { leaky?: boolean; routing?: GateRouting; onItem?: (o: GateOutcome, i: number) => Promise<void> | void } = {},
): Promise<GateOutcome[]> {
  const out: GateOutcome[] = [];
  const routing = opts.routing ?? "rules";
  for (const [i, bankItem] of items.entries()) {
    const forbidden = forbiddenFor(GATE_USERS[bankItem.as]);
    // Model routing: every item reaches the model, so a rules item gets the
    // script an honest model would follow (scriptFromRules).
    const item = routing === "model" && !bankItem.scripted ? { ...bankItem, scripted: await scriptFromRules(bankItem, post, hooks) } : bankItem;
    const run = await withRouting(routing, () => runGateTurn(item, post, hooks, "rls"));
    const verdict = gradeItem(item, run, forbidden, routing);
    let leakyLeaks: string[] | null = null;
    if (opts.leaky) {
      const leaky = gradeItem(item, await withRouting(routing, () => runGateTurn(item, post, hooks, "leaky")), forbidden, routing);
      leakyLeaks = leaky.leaks;
    }
    const o = { verdict, leakyLeaks, results: run.results };
    out.push(o);
    await opts.onItem?.(o, i);
  }
  return out;
}
