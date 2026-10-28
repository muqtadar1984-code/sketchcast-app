import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { canonicalSha } from "./hash";
import { readRunsFile, runsFile, writeRunsFile } from "./runs";
import { getChapter, listApprovals, listFindings } from "./store";
import type { Approval, Finding } from "./types";

// What a member decides in the book app (R1 S4, migration 0167):
//   ruleFinding   accept / reject (with a reason) / defer / reopen a finding; the finding's status changes and the
//                 ruling is kept, append-only, in pub_finding_decisions
//   approveGateD  approve a chapter's CURRENT text; the approval is the engine's own hash of that text
//                 (canonicalSha, checked against all 60 stored Biology texts), inserted into pub_approvals, which a
//                 trigger keeps insert-only
// Callers have already checked the member's right on the book. Development (BOOKS_FIXTURE): writes go to
// BOOKS_RUNS_FILE and the store overlays them, so nothing reaches production.

export type Ruling = "accepted" | "rejected" | "deferred" | "open";
export const RULINGS: Ruling[] = ["accepted", "rejected", "deferred", "open"];

export type FindingDecision = {
  id: number;
  finding_id: number;
  status_from: string;
  status_to: string;
  reason: string | null;
  decided_by: string;
  decided_at: string;
};

/** A finding already applied to the text is history: it is not re-ruled here (a new audit raises a new finding). */
export function canRule(f: Finding, to: Ruling): string | null {
  if (f.status === "applied") return "This finding was already applied to the text.";
  if (f.status === to) return `The finding is already ${to}.`;
  return null;
}

export async function ruleFinding(input: { workUid: string; findingId: number; to: Ruling; reason: string; by: string }) {
  const finding = (await listFindings(input.workUid)).find((f) => f.id === input.findingId);
  if (!finding) return { error: "Unknown finding.", status: 404 };
  const refused = canRule(finding, input.to);
  if (refused) return { error: refused, status: 409 };
  const reason = input.reason.trim();
  if (input.to === "rejected" && !reason) return { error: "A rejection needs a reason.", status: 400 };
  const at = new Date().toISOString();
  const decision = { ...(finding.decision ?? {}), ruling: input.to, reason: reason || null, by: input.by, at };
  const log = { finding_id: finding.id, work_uid: input.workUid, status_from: finding.status, status_to: input.to, reason: reason || null, decided_by: input.by, decided_at: at };

  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const patch = ((d as unknown as Record<string, Record<string, unknown>>).pub_findings_patch ??= {});
    patch[String(finding.id)] = { status: input.to, decision };
    d.pub_finding_decisions = [...(d.pub_finding_decisions ?? []), { ...log, id: (d.pub_finding_decisions?.length ?? 0) + 1 }];
    writeRunsFile(f, d);
    return { ok: true };
  }
  const admin = createAdminClient();
  // only if nobody ruled it in between (the status we showed is still the status)
  const { data, error } = await admin
    .from("pub_findings")
    .update({ status: input.to, decision })
    .eq("id", finding.id)
    .eq("work_uid", input.workUid)
    .eq("status", finding.status)
    .select("id");
  if (error) throw new Error(`pub_findings: ${error.message}`);
  if (!data?.length) return { error: "Someone else ruled on this finding a moment ago; reload.", status: 409 };
  const { error: logError } = await admin.from("pub_finding_decisions").insert(log);
  if (logError) {
    // the ruling must never exist without its record: undo the status change
    await admin.from("pub_findings").update({ status: finding.status, decision: finding.decision }).eq("id", finding.id);
    throw new Error(`pub_finding_decisions: ${logError.message}`);
  }
  return { ok: true };
}

export async function listDecisions(workUid: string): Promise<FindingDecision[]> {
  const f = runsFile();
  if (f) return ((readRunsFile(f).pub_finding_decisions ?? []) as unknown as (FindingDecision & { work_uid: string })[]).filter((d) => d.work_uid === workUid);
  const { data, error } = await createAdminClient()
    .from("pub_finding_decisions")
    .select("id, finding_id, status_from, status_to, reason, decided_by, decided_at")
    .eq("work_uid", workUid)
    .order("id", { ascending: true });
  if (error) throw new Error(`pub_finding_decisions: ${error.message}`);
  return (data ?? []) as FindingDecision[];
}

/** The Gate D approval that already covers this exact text, if any. */
export function approvalOfText(approvals: Approval[], chapter: number, sha: string): Approval | null {
  return approvals.find((a) => a.kind === "gate_d" && a.chapter === chapter && a.content_sha256 === sha) ?? null;
}

export async function approveGateD(input: { workUid: string; revisionKey: string; chapter: number; by: string; note: string }) {
  const ch = await getChapter(input.workUid, input.revisionKey, input.chapter);
  if (!ch) return { error: "Unknown chapter.", status: 404 };
  const sha = canonicalSha(ch.body);
  // the stored hash and the text must agree before anything is approved
  if (sha !== ch.content_sha256) return { error: "The stored text and its hash disagree; nothing was approved.", status: 409 };
  if (approvalOfText(await listApprovals(input.workUid), input.chapter, sha)) return { error: "This exact text is already Gate D approved.", status: 409 };
  const today = new Date().toISOString().slice(0, 10);
  const row = {
    work_uid: input.workUid,
    kind: "gate_d",
    scope: "chapter",
    chapter: input.chapter,
    revision_key: input.revisionKey,
    stage_key: "gate_d",
    label: `Gate D — Chapter ${input.chapter} (${input.revisionKey}), approved in the book app`,
    approved_by: input.by,
    approved_on: today,
    basis: input.note.trim() || "Approved in the book app after reading the chapter.",
    content_sha256: sha,
    hash_of: "sections+exercises (canonical)",
    hash_verified: true,
    waived: [],
    open_flags: [],
  };
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    d.pub_approvals = [...(d.pub_approvals ?? []), { ...row, id: 900000 + (d.pub_approvals?.length ?? 0) }];
    writeRunsFile(f, d);
    return { ok: true, sha };
  }
  const { error } = await createAdminClient().from("pub_approvals").insert(row);
  if (error) throw new Error(`pub_approvals: ${error.message}`);
  return { ok: true, sha };
}
