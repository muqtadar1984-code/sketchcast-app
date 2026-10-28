import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { runnableStage, checkParams } from "@/utils/books/stages";
import { createRun, estimateRun, launchRunner, noteRun } from "@/utils/books/runs";
import { sameOrigin } from "./same-origin";

export const runtime = "nodejs";

// POST /api/pub/runs  {book, stage, params}  →  201 {id, note}
// Queues a book run and starts the books runner for it. 404 for non-members and
// unknown books (the app is not probeable); 403 when the member's role may not
// run that stage; 400 for an unknown stage or bad parameters.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { book?: string; stage?: string; params?: Record<string, unknown> };
  const work = await getWork(body.book ?? "");
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  const stage = runnableStage(body.stage ?? "");
  if (!stage) return NextResponse.json({ error: "Unknown stage." }, { status: 400 });
  if (!canOn(m, work.uid, stage.action)) return NextResponse.json({ error: "Your role on this book may not run this stage." }, { status: 403 });
  const checked = checkParams(stage, body.params ?? {});
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });

  const estimate = await estimateRun(work.uid, stage, checked.params);
  const id = await createRun({ workUid: work.uid, stage, params: checked.params, requestedBy: m.email, estimateUsd: estimate.usd });
  await noteRun(id, `Queued by ${m.email}. Estimate $${estimate.usd.toFixed(2)} (${estimate.basis}).`);
  const launch = await launchRunner(id);
  await noteRun(id, launch.note, launch.started ? "info" : "warning");
  return NextResponse.json({ id, note: launch.note }, { status: 201 });
}
