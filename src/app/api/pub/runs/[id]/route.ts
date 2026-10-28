import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { runnableStage } from "@/utils/books/stages";
import { getBookRun, launchRunner, listRunEvents, noteRun, requestCancel } from "@/utils/books/runs";
import { sameOrigin } from "../same-origin";

export const runtime = "nodejs";

async function load(request: Request, idParam: string) {
  const m = await isBookMemberRequest();
  if (!m) return null;
  const url = new URL(request.url);
  const work = await getWork(url.searchParams.get("book") ?? "");
  const id = Number(idParam);
  if (!work || !Number.isInteger(id) || !canOn(m, work.uid, "read")) return null;
  const run = await getBookRun(work.uid, id);
  return run ? { m, work, run, url } : null;
}

// GET /api/pub/runs/<id>?book=<slug>&after=<event id>  →  {run, events}
// What the Runs page polls every few seconds while a run is queued or running.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const got = await load(request, (await params).id);
  if (!got) return new NextResponse(null, { status: 404 });
  const after = Number(got.url.searchParams.get("after") ?? 0) || 0;
  const events = await listRunEvents(got.run.id, after);
  return NextResponse.json({ run: got.run, events }, { headers: { "cache-control": "private, no-store" } });
}

// POST /api/pub/runs/<id>?book=<slug>  {action: "cancel" | "retry"}
// cancel: a queued run stops at once, a running one at the runner's next heartbeat.
// retry:  starts the runner again for a run that is still queued (a task that never started).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const got = await load(request, (await params).id);
  if (!got) return new NextResponse(null, { status: 404 });
  const { m, work, run } = got;
  const stage = runnableStage(run.stage_key);
  if (!stage || !canOn(m, work.uid, stage.action)) return NextResponse.json({ error: "Your role on this book may not change this run." }, { status: 403 });
  const { action } = (await request.json().catch(() => ({}))) as { action?: string };

  if (action === "cancel") {
    if (run.status !== "queued" && run.status !== "running") return NextResponse.json({ error: `The run is already ${run.status}.` }, { status: 409 });
    await requestCancel(run);
    await noteRun(run.id, `Cancel requested by ${m.email}.`, "warning");
    return NextResponse.json({ ok: true });
  }
  if (action === "retry") {
    if (run.status !== "queued") return NextResponse.json({ error: "Only a run that is still queued can be started again." }, { status: 409 });
    const launch = await launchRunner(run.id);
    await noteRun(run.id, `Retry by ${m.email}: ${launch.note}`, launch.started ? "info" : "warning");
    return NextResponse.json({ ok: launch.started, note: launch.note });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
