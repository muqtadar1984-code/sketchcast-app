import "server-only";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { createAdminClient } from "@/utils/supabase/admin";
import { bedrockRoleCredentials } from "@/utils/claude-backend";
import { fixturePath } from "./store";
import { runChapters, type RunnableStage } from "./stages";
import type { Artifact, Run, RunEvent } from "./types";

// Book runs (R1, migration 0165): queue a run in pub_runs, start the books
// runner for it (one AWS Fargate task per run), read its log, ask it to stop.
// Book runs never touch public.jobs. Callers have already checked the member
// and their right to run the stage.
//
// Development: with BOOKS_FIXTURE set (never in production) the run tables live
// in a JSON file — BOOKS_RUNS_FILE — in the shape the runner's FileStore reads,
// so a run queued here is executed on this PC with
//   python -m publishing.runner --run-id <id> --store file:<BOOKS_RUNS_FILE> --bucket s3

type Row = Record<string, unknown>;
type RunsFile = { pub_works: Row[]; pub_runs: Row[]; pub_run_events: Row[]; [table: string]: Row[] };

function runsFile(): string | null {
  if (!fixturePath()) return null;
  return process.env.BOOKS_RUNS_FILE || null;
}

function readRunsFile(path: string): RunsFile {
  if (!existsSync(/*turbopackIgnore: true*/ path)) return { pub_works: [], pub_runs: [], pub_run_events: [] };
  const d = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf-8")) as RunsFile;
  d.pub_runs ??= [];
  d.pub_run_events ??= [];
  d.pub_works ??= [];
  return d;
}

function writeRunsFile(path: string, d: RunsFile) {
  writeFileSync(/*turbopackIgnore: true*/ path, JSON.stringify(d, null, 1), "utf-8");
}

const APP_RUN = (r: Row) => r.trigger === "app" || r.trigger === "cli";

/** The book's runs started from the app or a terminal, newest first (imported history stays on the Overview). */
export async function listBookRuns(workUid: string, limit = 50): Promise<Run[]> {
  const f = runsFile();
  if (f) {
    return readRunsFile(f).pub_runs
      .filter((r) => r.work_uid === workUid && APP_RUN(r))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit) as Run[];
  }
  const { data, error } = await createAdminClient()
    .from("pub_runs")
    .select("*")
    .eq("work_uid", workUid)
    .in("trigger", ["app", "cli"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`pub_runs: ${error.message}`);
  return (data ?? []) as Run[];
}

export async function getBookRun(workUid: string, id: number): Promise<Run | null> {
  const f = runsFile();
  if (f) return (readRunsFile(f).pub_runs.find((r) => r.work_uid === workUid && r.id === id) as Run | undefined) ?? null;
  const { data, error } = await createAdminClient().from("pub_runs").select("*").eq("work_uid", workUid).eq("id", id).maybeSingle();
  if (error) throw new Error(`pub_runs: ${error.message}`);
  return (data as Run | null) ?? null;
}

/** Log lines after `afterId`, oldest first. */
export async function listRunEvents(runId: number, afterId = 0, limit = 500): Promise<RunEvent[]> {
  const f = runsFile();
  if (f) {
    return readRunsFile(f).pub_run_events
      .map((e, i): Row => ({ ...e, id: (e.id as number | undefined) ?? i + 1 }))
      .filter((e) => e.run_id === runId && (e.id as number) > afterId)
      .slice(0, limit) as unknown as RunEvent[];
  }
  const { data, error } = await createAdminClient()
    .from("pub_run_events")
    .select("id, at, level, kind, message")
    .eq("run_id", runId)
    .gt("id", afterId)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`pub_run_events: ${error.message}`);
  return (data ?? []) as RunEvent[];
}

/** The files a run produced (in development they are listed from BOOKS_RUNS_FILE; links open only in production). */
export async function listRunArtifacts(workUid: string, runId: number): Promise<Artifact[]> {
  const f = runsFile();
  if (f) {
    return ((readRunsFile(f).pub_artifacts ?? []) as Row[])
      .map((a, i): Row => ({ ...a, id: (a.id as number | undefined) ?? 100000 + i }))
      .filter((a) => a.work_uid === workUid && a.run_id === runId) as unknown as Artifact[];
  }
  const { data, error } = await createAdminClient().from("pub_artifacts").select("*").eq("work_uid", workUid).eq("run_id", runId).order("rel_path");
  if (error) throw new Error(`pub_artifacts: ${error.message}`);
  return (data ?? []) as Artifact[];
}

/**
 * The estimate shown before Run: the measured cost per chapter of this book's
 * finished runs of the stage, else the stage's measured default. Never a cap
 * (founder 2026-10-28, D5: estimates only).
 */
export async function estimateRun(workUid: string, stage: RunnableStage, params: Record<string, number>) {
  const chapters = Math.max(1, runChapters(params).length);
  const done = (await listBookRuns(workUid, 200)).filter((r) => r.stage_key === stage.key && r.status === "done" && r.usd !== null);
  const runChs = done.reduce((s, r) => s + Math.max(1, (r.chapters ?? []).length), 0);
  if (runChs > 0) {
    const per = done.reduce((s, r) => s + Number(r.usd), 0) / runChs;
    return { usd: per * chapters, basis: `measured on this book's last ${done.length} run(s) of this stage` };
  }
  return { usd: stage.measuredPerChapterUsd * chapters, basis: stage.measuredFrom };
}

export async function createRun(input: {
  workUid: string;
  stage: RunnableStage;
  params: Record<string, number>;
  requestedBy: string;
  estimateUsd: number;
}): Promise<number> {
  const chapters = runChapters(input.params);
  const label = chapters.length ? `${input.stage.title} · chapters ${chapters[0]}–${chapters[chapters.length - 1]}` : input.stage.title;
  const row = {
    work_uid: input.workUid,
    stage_key: input.stage.key,
    label,
    chapters,
    status: "queued",
    trigger: "app",
    params: input.params,
    requested_by: input.requestedBy,
    estimate_usd: Number(input.estimateUsd.toFixed(4)),
    progress: { step: "queued", note: "waiting for the runner" },
    detail: {},
  };
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const id = Math.max(0, ...d.pub_runs.map((r) => Number(r.id) || 0)) + 1;
    d.pub_runs.push({ ...row, id, created_at: new Date().toISOString() });
    if (!d.pub_works.some((w) => w.uid === input.workUid)) d.pub_works.push({ uid: input.workUid, slug: input.workUid });
    writeRunsFile(f, d);
    return id;
  }
  const { data, error } = await createAdminClient().from("pub_runs").insert(row).select("id").single();
  if (error) throw new Error(`pub_runs: ${error.message}`);
  return Number((data as { id: number }).id);
}

export async function noteRun(runId: number, message: string, level: "info" | "warning" | "error" = "info") {
  const event = { run_id: runId, at: new Date().toISOString(), level, kind: "progress", message };
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    d.pub_run_events.push({ ...event, id: d.pub_run_events.length + 1 });
    writeRunsFile(f, d);
    return;
  }
  await createAdminClient().from("pub_run_events").insert(event);
}

/** Cancel: a queued run is cancelled at once; a running one stops at the runner's next heartbeat (≤ 15 s). */
export async function requestCancel(run: Run): Promise<void> {
  const now = new Date().toISOString();
  const queued = run.status === "queued";
  const patch: Row = queued
    ? { status: "cancelled", cancel_requested_at: now, finished_at: now, progress: { step: "finished", note: "cancelled before it started" } }
    : { cancel_requested_at: now };
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const r = d.pub_runs.find((x) => x.id === run.id);
    if (r) Object.assign(r, patch);
    writeRunsFile(f, d);
    return;
  }
  // the status filter keeps a race with the runner's claim honest: only a still-queued row is cancelled outright
  let q = createAdminClient().from("pub_runs").update(patch).eq("id", run.id);
  q = queued ? q.eq("status", "queued") : q.in("status", ["running", "queued"]);
  const { error } = await q;
  if (error) throw new Error(`pub_runs: ${error.message}`);
}

// ── the runner ────────────────────────────────────────────────────────────────

type RunnerConfig = { cluster: string; taskDefinition: string; subnets: string[]; securityGroups: string[]; region: string };

/** BOOKS_RUNNER_* — unset means runs stay queued (the Runs page says so). */
export function runnerConfig(): RunnerConfig | null {
  const cluster = (process.env.BOOKS_RUNNER_CLUSTER || "").trim();
  const taskDefinition = (process.env.BOOKS_RUNNER_TASK_DEF || "").trim();
  const subnets = (process.env.BOOKS_RUNNER_SUBNETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const securityGroups = (process.env.BOOKS_RUNNER_SECURITY_GROUPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!cluster || !taskDefinition || !subnets.length) return null;
  return { cluster, taskDefinition, subnets, securityGroups, region: process.env.BOOKS_RUNNER_REGION || "us-east-1" };
}

let ecs: ECSClient | null = null;

/** Start one Fargate task for the run. Returns a note for the run's log; never throws (the run stays queued). */
export async function launchRunner(runId: number): Promise<{ started: boolean; note: string }> {
  const cfg = runnerConfig();
  if (!cfg) {
    return runsFile()
      ? { started: false, note: `Queued. Development: start it with  python -m publishing.runner --run-id ${runId} --store file:<BOOKS_RUNS_FILE>` }
      : { started: false, note: "Queued, but the books runner is not configured yet (BOOKS_RUNNER_*), so it will wait." };
  }
  try {
    const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
    ecs ??= roleArn ? new ECSClient({ region: cfg.region, credentials: bedrockRoleCredentials(roleArn, cfg.region) }) : new ECSClient({ region: cfg.region });
    const out = await ecs.send(
      new RunTaskCommand({
        cluster: cfg.cluster,
        taskDefinition: cfg.taskDefinition,
        launchType: "FARGATE",
        count: 1,
        startedBy: `book-run-${runId}`,
        networkConfiguration: {
          awsvpcConfiguration: { subnets: cfg.subnets, securityGroups: cfg.securityGroups, assignPublicIp: "ENABLED" },
        },
        overrides: { containerOverrides: [{ name: "runner", command: ["--run-id", String(runId)] }] },
      }),
    );
    const fail = out.failures?.[0];
    if (fail || !out.tasks?.length) return { started: false, note: `The runner did not start: ${fail?.reason ?? "no task returned"}. The run stays queued; press Retry.` };
    return { started: true, note: "Runner started on AWS; it picks the run up within a minute." };
  } catch (e) {
    return { started: false, note: `The runner did not start: ${(e as Error).message}. The run stays queued; press Retry.` };
  }
}
