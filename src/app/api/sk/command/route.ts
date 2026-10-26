import { NextResponse } from "next/server";
import { isEventId } from "@/sk/ids";
import { LoopError, runCommand } from "@/sk/loop";
import { gate, loopDepsFor, readBody, skDeps } from "@/sk/server";
import { withEvent } from "@/sk/store";
import { COMMANDS, EXPLAIN_STYLES, type Command, type CommandArgs, type Cursor } from "@/sk/types";

export const runtime = "nodejs";

/** Untrusted args → the closed CommandArgs shape (anything else is dropped). */
export function parseCommandArgs(raw: unknown): CommandArgs {
  const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: CommandArgs = {};
  if (typeof a.unitKey === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(a.unitKey)) out.unitKey = a.unitKey;
  if (typeof a.n === "number" && Number.isInteger(a.n) && a.n >= 0 && a.n <= 10) out.n = a.n;
  if (typeof a.style === "string" && (EXPLAIN_STYLES as readonly string[]).includes(a.style)) out.style = a.style as CommandArgs["style"];
  if (typeof a.withCheck === "boolean") out.withCheck = a.withCheck;
  if (a.scope === "segment" || a.scope === "unit") out.scope = a.scope;
  return out;
}

export function parseCursor(raw: unknown): Partial<Cursor> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  return {
    unitKey: typeof c.unitKey === "string" ? c.unitKey : undefined,
    assetId: typeof c.assetId === "string" ? c.assetId : undefined,
    segmentId: typeof c.segmentId === "string" ? c.segmentId : undefined,
    t: typeof c.t === "number" ? c.t : undefined,
  };
}

// POST /api/sk/command — { eventId, sessionId, command, args?, cursor? } → { state, cursor, bookmarks, … }
export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; sessionId?: unknown; command?: unknown; args?: unknown; cursor?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  if (typeof body.command !== "string" || !(COMMANDS as readonly string[]).includes(body.command)) return NextResponse.json({ error: "Unknown command." }, { status: 400 });

  const d = await skDeps();
  const s = await d.store.getSession(String(body.sessionId ?? ""));
  if (!s || s.studentId !== g.userId) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const deps = loopDepsFor(d, s.productId, s.chapter);
  if (!deps) return NextResponse.json({ error: "The session's lesson graph is no longer available." }, { status: 410 });

  const command: Command = { name: body.command as Command["name"], args: parseCommandArgs(body.args) };
  try {
    const { result } = await withEvent(deps.store, s.id, body.eventId, `command.${command.name}`, () => runCommand(deps, s, command, parseCursor(body.cursor)));
    return NextResponse.json({ ...result.view, speech: result.speech, board: result.board, decision: result.decision ? { kind: result.decision.kind, reasons: result.decision.reasons } : undefined, refused: result.refused });
  } catch (e) {
    if (e instanceof LoopError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[sk] command failed:", e);
    return NextResponse.json({ error: "Could not apply the command." }, { status: 500 });
  }
}
