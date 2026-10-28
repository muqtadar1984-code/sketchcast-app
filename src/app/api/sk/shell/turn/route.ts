import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { AnthropicProvider } from "@/utils/assistant/providers/anthropic";
import type { Turn } from "@/utils/assistant/provider";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";
import { loadContext } from "@/sk/shell/context";
import { openMemory, rememberTurn, sealMemory } from "@/sk/shell/memory";
import { allowedFor, toToolDefs } from "@/sk/shell/registry";
import { makeRunTool, runCapability, type RunnerDeps, type ToolTrace } from "@/sk/shell/runner";
import { auditSinkFor } from "@/sk/shell/audit";
import { routeByRules } from "@/sk/shell/rules";
import { buildShellPrompt, groundingCheck } from "@/sk/shell/prompt";
import { issueActionToken } from "@/sk/shell/tokens";
import { SK_CANNOT_CONFIRM, SK_NOTHING_ON_THAT, type ResolvedEntity, type SkCapabilityResult, type SkCollector, type SkTurnEvent, type SkTurnRequest } from "@/sk/shell/types";

export const runtime = "nodejs";

// POST /api/sk/shell/turn — one SK Shell turn (Final Plan §2.1–2.3, S0).
//
// Gate → Context (server-built) → signed memory → rules router. A navigate is
// deterministic (no model call): resolve the class, run `navigate`, emit the
// path. Everything else goes to the teacher model with the registry's allowed
// tools; the answer is BUFFERED and checked by groundingCheck before anything
// reaches the client, so an invented number or name is stripped and an empty
// tool set yields exactly SK_NOTHING_ON_THAT. One `data:` JSON line per event.
//
// Not in S0: writing the turn to assistant_messages (those tables are keyed by
// student session) — the audit rows per capability are the S0 trail.
//
// S1 (slice B): a capability result may carry `board` (an immediate Board move
// the client performs — emitted as a `board` event, labelled grounded) or
// `confirm` (a confirm-tier action with resolved params — the route issues the
// action token and emits a `confirm` card; NOTHING is executed here, the
// client returns the token to /api/sk/act). Both come either from the rules
// router (Board phrasings while a Board session is open) or from a tool the
// model chose; the handling is one code path.

const SK_SHELL_DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TEXT = 600;

const enc = new TextEncoder();
const frame = (ev: SkTurnEvent) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);

type Gate =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string; email?: string | null; email_confirmed_at?: string | null }; role: string | null; schoolId: string | null }
  | { ok: false; status: number; error: string };

async function gate(): Promise<Gate> {
  if (!skEnabled()) return { ok: false, status: 404, error: "Not available." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) return { ok: false, status: 404, error: "Not available." };
  return { ok: true, supabase, user, role, schoolId };
}

function parseBody(raw: unknown): SkTurnRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Invalid body." };
  const b = raw as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { error: "Say something." };
  if (text.length > MAX_TEXT) return { error: `Keep it under ${MAX_TEXT} characters.` };
  const turnId = typeof b.turnId === "string" && b.turnId.trim() && b.turnId.length <= 80 ? b.turnId.trim() : "";
  if (!turnId) return { error: "turnId is required." };
  const modality = b.modality === "voice" ? "voice" : "text";
  const c = (b.collector && typeof b.collector === "object" ? b.collector : {}) as Record<string, unknown>;
  const clock = c.clock && typeof c.clock === "object" ? (c.clock as SkCollector["clock"]) : undefined;
  const collector: SkCollector = {
    path: typeof c.path === "string" ? c.path.slice(0, 300) : "/dashboard",
    params: c.params && typeof c.params === "object" ? (c.params as Record<string, string>) : undefined,
    selection: c.selection && typeof c.selection === "object" ? (c.selection as SkCollector["selection"]) : undefined,
    board: c.board && typeof c.board === "object" ? (c.board as SkCollector["board"]) : undefined,
    clock:
      clock && typeof clock.day === "number" && typeof clock.minutes === "number" && typeof clock.iso === "string"
        ? { day: clock.day, minutes: clock.minutes, iso: clock.iso.slice(0, 40) }
        : undefined,
    locale: typeof c.locale === "string" ? c.locale.slice(0, 10) : undefined,
  };
  const memory = typeof b.memory === "string" && b.memory.length <= 64_000 ? b.memory : undefined;
  return { turnId, text, modality, collector, memory };
}

export async function POST(request: Request) {
  const t0 = Date.now();
  const g = await gate();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const body = parseBody(raw);
  if ("error" in body) return NextResponse.json({ error: body.error }, { status: 400 });

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null; // plan → "unknown"; audit → memory sink
  }
  const cookieStore = await cookies();
  const now = new Date();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const ctx = await loadContext({
    session: g.supabase,
    admin,
    cookies: cookieStore,
    user: g.user,
    profile: { role: g.role, school_id: g.schoolId },
    collector: body.collector,
    locale: isLocale(body.collector.locale) ? body.collector.locale : isLocale(localeCookie) ? localeCookie : "en",
    now,
  });

  let memory = openMemory(body.memory, ctx, now).memory;
  const allowed = allowedFor(ctx);
  const sink = auditSinkFor(admin);
  const decision = routeByRules(body.text, ctx, now, body.collector.clock);

  // One controller, two sources: the request's own signal (client gone) and
  // the stream's cancel() (reader let go). Same pattern as /api/assistant.
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (request.signal?.aborted) abort.abort();
  else request.signal?.addEventListener("abort", onRequestAbort, { once: true });

  const deps: RunnerDeps = {
    session: g.supabase,
    now,
    clock: body.collector.clock,
    signal: abort.signal,
    sink,
    sessionId: memory.sessionId,
    turnId: body.turnId,
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      const send = (ev: SkTurnEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(frame(ev));
        } catch {
          /* client gone */
        }
      };
      const finish = () => {
        request.signal?.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const done = (ev: Omit<Extract<SkTurnEvent, { type: "done" }>, "type" | "latencyMs" | "memory">, assistantText: string, entities: ResolvedEntity[]) => {
        memory = rememberTurn(memory, { user: body.text, assistant: assistantText, entities }, new Date());
        send({ type: "done", ...ev, latencyMs: Date.now() - t0, memory: sealMemory(memory) });
      };

      /** S1: turn a capability result's `board` / `confirm` into the event the
       *  client acts on. The token is issued HERE and nowhere else; when no
       *  secret is configured the action is declined, not executed weakly. */
      const actionEvent = async (r: SkCapabilityResult): Promise<{ event: SkTurnEvent; say: string } | { declined: string } | null> => {
        if (!r.ok) return null;
        if (r.board) {
          const say = r.board.say ?? r.summary;
          return { event: { type: "board", move: r.board.move, args: r.board.args ?? {}, say: r.board.say }, say };
        }
        if (r.confirm) {
          const issued = admin
            ? await issueActionToken(admin, { userId: ctx.user.id, action: r.confirm.action, params: r.confirm.params, contextHash: ctx.contextHash, now: new Date() })
            : null;
          if (!issued) return { declined: SK_CANNOT_CONFIRM };
          return {
            event: { type: "confirm", token: issued.token, action: r.confirm.action, title: r.confirm.title, params: r.confirm.params, expiresAt: issued.expiresAt },
            say: r.summary,
          };
        }
        return null;
      };

      try {
        send({ type: "meta", sessionId: memory.sessionId, turnId: body.turnId, intent: decision.intent, capabilities: allowed.map((c) => c.meta.name) });

        // ── S1 Board move by rules: deterministic, audited, no model ─────────
        if (decision.intent === "teach") {
          const name = `board.${decision.move}`;
          const r = await runCapability(ctx, name, decision.args, deps);
          send({ type: "tool", name, ok: r.ok, summary: r.summary });
          const act = await actionEvent(r);
          if (act && "event" in act) {
            send(act.event);
            done({ sources: [name], label: "grounded" }, act.say, r.entities ?? []);
          } else if (!r.ok && r.error === "no board") {
            // The Board is not open: say so and offer the way there.
            const nav = await runCapability(ctx, "navigate", { target: "board" }, deps);
            send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
            send({ type: "text", text: r.summary });
            if (nav.ok && nav.navigate) {
              send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
              done({ sources: ["navigate"], label: "navigation" }, r.summary, []);
            } else done({ sources: [], label: "declined" }, r.summary, []);
          } else {
            const text = act && "declined" in act ? act.declined : r.summary;
            send({ type: "text", text });
            done({ sources: [], label: "declined" }, text, []);
          }
          finish();
          return;
        }

        // ── Navigate: deterministic, audited, no model ───────────────────────
        if (decision.intent === "navigate") {
          const sources: string[] = [];
          const entities: ResolvedEntity[] = [];
          const filters: Record<string, unknown> = { ...decision.filters };
          const lookups: Array<[string, "class" | "learner", string]> = [];
          if (decision.classQuery) lookups.push(["classId", "class", decision.classQuery]);
          if (decision.learnerQuery) lookups.push(["learnerId", "learner", decision.learnerQuery]);
          let missing: string | null = null;
          for (const [key, kind, query] of lookups) {
            const r = await runCapability(ctx, "context.resolve", { query, kind }, deps);
            send({ type: "tool", name: "context.resolve", ok: r.ok, summary: r.summary });
            const hit = (r.entities ?? []).find((e) => e.kind === kind);
            if (hit) {
              filters[key] = hit.id;
              entities.push(hit);
              sources.push("context.resolve");
            } else missing = `${kind} "${query}"`;
          }
          const nav = await runCapability(ctx, "navigate", { target: decision.target, ...filters }, deps);
          send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
          if (nav.ok && nav.navigate) {
            const text = missing ? `I couldn't find ${missing} — ${nav.summary}` : nav.summary;
            send({ type: "text", text });
            send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
            done({ sources: [...new Set([...sources, "navigate"])], label: "navigation" }, text, entities);
          } else {
            send({ type: "text", text: nav.summary });
            done({ sources: [], label: "declined" }, nav.summary, entities);
          }
          finish();
          return;
        }

        // ── Bare acknowledgement with nothing pending ────────────────────────
        if (decision.intent === "chat") {
          send({ type: "text", text: decision.reply });
          done({ sources: [], label: "supplementary" }, decision.reply, []);
          finish();
          return;
        }

        // ── The model, with the allowed tools ────────────────────────────────
        const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL);
        const trace: ToolTrace[] = [];
        const run = makeRunTool(ctx, deps, trace);
        const history: Turn[] = memory.turns.map((t) => ({ role: t.role, text: t.text }));
        const system = buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory });
        let full = "";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let cancelled = false;
        let failed = false;

        for await (const ev of runAssistantTurn({
          provider,
          system,
          history,
          question: body.text,
          tools: allowed.length ? toToolDefs(allowed) : undefined,
          runTool: async (call) => {
            const out = await run(call);
            const last = trace[trace.length - 1];
            if (last) send({ type: "tool", name: last.name, ok: last.result.ok, summary: last.result.summary.slice(0, 200) });
            return out;
          },
          maxToolRounds: 3,
          maxTokens: 600,
          signal: abort.signal,
        })) {
          if (ev.type === "text") full += ev.text; // buffered: grounding runs before the client sees a word
          else if (ev.type === "done") usage = ev.usage;
          else if (ev.type === "cancelled") {
            cancelled = true;
            usage = ev.usage;
          } else if (ev.type === "error") {
            failed = true;
            // The raw provider message stays server-side (Vercel runtime logs);
            // the client only ever gets the friendly line.
            console.error("sk-shell.turn provider", ev.retryable ? "retryable" : "fatal", ev.message);
            send({ type: "error", message: ev.retryable ? "One moment — try that again in a few seconds." : "I couldn't answer that one. Try asking a different way?" });
          }
        }
        if (cancelled || failed) {
          finish();
          return;
        }

        // ── S1: a Board move or a confirm card the MODEL chose ───────────────
        // The last successful one wins; the token (if any) is issued before a
        // word reaches the client so a refusal can replace the text.
        const actHit = [...trace].reverse().find((t) => t.result.ok && (t.result.board || t.result.confirm));
        const act = actHit ? await actionEvent(actHit.result) : null;

        // ── Grounding (§2.3, §9.3) ───────────────────────────────────────────
        const productive = trace.filter(
          (t) => (t.result.facts?.length ?? 0) > 0 || !!t.result.navigate || (t.result.entities?.length ?? 0) > 0 || (t.result.ok && (!!t.result.board || !!t.result.confirm)),
        );
        const support = trace.flatMap((t) => [t.result.summary, ...(t.result.facts ?? [])]);
        const verdict = groundingCheck(full, support, body.text);
        if (!verdict.ok) {
          // Server-side only: which tokens failed and what was dropped, so a
          // false positive can be diagnosed from the runtime logs (2026-10-28).
          console.info("sk-shell.turn grounding", JSON.stringify({ turnId: body.turnId, tools: trace.map((t) => t.name), unsupported: verdict.unsupported, dropped: verdict.dropped }));
        }
        const navHit = [...trace].reverse().find((t) => t.result.ok && t.result.navigate)?.result.navigate;
        let text: string;
        let label: Extract<SkTurnEvent, { type: "done" }>["label"];
        let trimmed = false;
        if (trace.length && !productive.length) {
          text = SK_NOTHING_ON_THAT;
          label = "declined";
        } else if (!trace.length) {
          text = verdict.ok && full.trim() ? full.trim() : SK_NOTHING_ON_THAT;
          label = verdict.ok && full.trim() ? "supplementary" : "declined";
        } else if (verdict.ok && full.trim()) {
          text = full.trim();
          label = navHit ? "navigation" : "grounded";
        } else if (verdict.text) {
          // What the user sees is only the supported sentences, so the shown
          // text IS grounded; `trimmed` records that something was dropped.
          text = verdict.text;
          label = navHit ? "navigation" : "grounded";
          trimmed = true;
        } else {
          text = navHit ? `Opening ${navHit.label}.` : SK_NOTHING_ON_THAT;
          label = navHit ? "navigation" : "declined";
        }
        if (act && "declined" in act) {
          // No token secret: the action is unavailable, whatever the model said.
          text = act.declined;
          label = "declined";
          trimmed = false;
        } else if (act) {
          // The move/card carries the grounded content; a silent model still
          // gets SK's own line for the transcript and the speaker.
          if (text === SK_NOTHING_ON_THAT) text = act.say;
          label = "grounded";
        }
        const sources = [...new Set(productive.map((t) => t.name))];
        const entities = trace.flatMap((t) => t.result.entities ?? []);
        send({ type: "text", text });
        if (navHit && !(act && "event" in act && act.event.type === "board")) send({ type: "navigate", path: navHit.path, label: navHit.label });
        if (act && "event" in act) send(act.event);
        done({ sources, label, ...(usage ? { usage } : {}), ...(trimmed ? { trimmed } : {}) }, text, entities);
        finish();
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error("sk-shell.turn", (e as Error).message);
          send({ type: "error", message: "Something went wrong — try again in a moment." });
        }
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
