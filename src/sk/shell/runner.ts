// SK Shell — the capability runner (Final Plan §2.5, §8.3). One place runs
// every capability: the registry predicate is checked AGAIN at execution time
// (per-tier revalidation), the handler gets the user-session client only,
// results are size-capped before the model sees them, and exactly one audit
// row is written — ok or not, with the duration.

import type { ToolCall } from "@/utils/assistant/provider";
import type { SkActionRow, SkCapability, SkCapabilityResult, SkCollector, SkContext, SkSessionDb } from "./types";
import { findCapability, fromApiToolName, metaAllows } from "./registry";
import { recordSafely, type SkAuditSink } from "./audit";
import { REGISTRY } from "@/sk/capabilities";

export const SK_FACTS_MAX_ROWS = 40;
export const SK_SUMMARY_MAX_CHARS = 1500;
export const SK_FACT_VALUE_MAX_CHARS = 300;

export type RunnerDeps = {
  session: SkSessionDb;
  now: Date;
  clock?: SkCollector["clock"];
  signal?: AbortSignal;
  sink: SkAuditSink;
  sessionId: string | null;
  turnId: string | null;
  entries?: SkCapability[];
  /** The turn's read memo (SkCapabilityDeps.cache); shared by every run of this turn. */
  cache?: Map<string, Promise<unknown>>;
};

/** Cap a handler's result so a wide table can never flood the prompt. */
export function capResult(r: SkCapabilityResult): SkCapabilityResult {
  const facts = (r.facts ?? []).slice(0, SK_FACTS_MAX_ROWS).map((row) => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row ?? {})) {
      out[k.slice(0, 60)] = typeof v === "string" ? v.slice(0, SK_FACT_VALUE_MAX_CHARS) : v;
    }
    return out;
  });
  return {
    ...r,
    summary: (r.summary ?? "").slice(0, SK_SUMMARY_MAX_CHARS),
    facts,
    entities: (r.entities ?? []).slice(0, 20),
  };
}

function paramsForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(args ?? {});
  if (s.length <= 4000) return args ?? {};
  return { truncated: true, head: s.slice(0, 4000) };
}

export async function runCapability(ctx: SkContext, name: string, args: Record<string, unknown>, deps: RunnerDeps): Promise<SkCapabilityResult> {
  const t0 = Date.now();
  const entries = deps.entries ?? REGISTRY;
  const cap = findCapability(name, entries);
  let result: SkCapabilityResult;
  if (!cap) {
    result = { ok: false, summary: "Unknown capability.", error: "unknown_capability", facts: [] };
  } else if (!metaAllows(cap.meta, ctx)) {
    // §2.5: the permission check runs again at execution time.
    result = { ok: false, summary: "Not available in your current view.", error: "not_allowed", facts: [] };
  } else if (deps.signal?.aborted) {
    result = { ok: false, summary: "Cancelled.", error: "aborted", facts: [] };
  } else {
    try {
      result = capResult(await cap.handler(ctx, args ?? {}, { session: deps.session, now: deps.now, clock: deps.clock, signal: deps.signal, cache: deps.cache, turnId: deps.turnId }));
    } catch (e) {
      result = { ok: false, summary: "That lookup failed.", error: (e as Error)?.message?.slice(0, 300) ?? "handler_threw", facts: [] };
    }
  }
  const row: SkActionRow = {
    actor_id: ctx.user.id,
    school_id: ctx.user.schoolId,
    role: ctx.user.role,
    hat: ctx.user.hat,
    action: name,
    tier: cap?.meta.tier ?? "immediate",
    kind: cap?.meta.kind ?? "read",
    params: paramsForAudit(args),
    ok: result.ok,
    result: {
      summary: result.summary.slice(0, 300),
      facts: result.facts?.length ?? 0,
      entities: result.entities?.length ?? 0,
      ...(result.navigate ? { navigate: result.navigate.path } : {}),
    },
    ...(result.error ? { error: result.error } : {}),
    session_id: deps.sessionId,
    generation_id: ctx.selection.generationId ?? null,
    token_id: null,
    turn_id: deps.turnId,
    at: new Date(t0).toISOString(),
    ms: Date.now() - t0,
  };
  await recordSafely(deps.sink, row);
  return result;
}

/** What the model reads back. Tool results are DATA (§8.3): wrapped so the
 *  model treats any instruction inside as content, never as a command. */
export function toolResultText(r: SkCapabilityResult): string {
  const body = { ok: r.ok, summary: r.summary, facts: r.facts ?? [], ...(r.navigate ? { navigate: r.navigate } : {}), ...(r.error ? { error: r.error } : {}) };
  return `<tool_result data_only="true">${JSON.stringify(body)}</tool_result>`;
}

export type ToolTrace = { name: string; args: Record<string, unknown>; result: SkCapabilityResult };

/** The orchestrator's `runTool` adapter; every call is traced for grounding.
 *  The orchestrator runs a round's calls side by side, so `onTrace` (not
 *  "the last trace entry") is how a caller learns which call just finished.
 *  The orchestrator's `signal` is the turn's own; it wins over deps.signal. */
export function makeRunTool(ctx: SkContext, deps: RunnerDeps, trace: ToolTrace[], onTrace?: (t: ToolTrace) => void): (call: ToolCall, signal?: AbortSignal) => Promise<string> {
  return async (call, signal) => {
    const args = call.args && typeof call.args === "object" ? call.args : {};
    // The model calls the API-safe name ("library__find"); the registry, the
    // audit row, the tool event and done.sources all keep the dotted name.
    const name = fromApiToolName(call.name);
    const result = await runCapability(ctx, name, args, signal ? { ...deps, signal } : deps);
    const t: ToolTrace = { name, args, result };
    trace.push(t);
    onTrace?.(t);
    return toolResultText(result);
  };
}
