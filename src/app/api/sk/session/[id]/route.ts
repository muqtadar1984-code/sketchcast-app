import { NextResponse } from "next/server";
import { sessionView } from "@/sk/loop";
import { gate, loopDepsFor, skDeps } from "@/sk/server";

export const runtime = "nodejs";

// GET /api/sk/session/:id — rehydrate (contracts §4, §5.4: reconnect = GET
// session → re-render from the server's snapshot). Only the session's own
// student may read it. Next 16: params arrive as a Promise.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const d = await skDeps();
  const s = await d.store.getSession(String(id));
  if (!s || s.studentId !== g.userId) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const deps = loopDepsFor(d, s.productId, s.chapter);
  if (!deps) return NextResponse.json({ error: "The session's lesson graph is no longer available." }, { status: 410 });
  return NextResponse.json(await sessionView(deps, s));
}
