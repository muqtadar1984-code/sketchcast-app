import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { readRunsFile, runsFile, writeRunsFile } from "./runs";

// Readiness waivers (migration 0168; founder 2026-10-29): an editor decides on the Gaps tab that one failing check
// does not block this book. The books runner hands the active waivers to the next Readiness re-check or Gate R,
// which records the check as a warning naming who waived it. Waivers are revoked, never edited or deleted.
// Callers have already checked the member's right on the book. Development (BOOKS_FIXTURE): BOOKS_RUNS_FILE.

export type Waiver = {
  id: number;
  work_uid: string;
  topic_id: string;
  topic_title: string | null;
  check_code: string;
  language: string | null;
  sub_status: string | null;
  reason: string;
  waived_by: string;
  waived_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
};

const TABLE = "pub_readiness_waivers";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_APPLIED = "Waiving checks is waiting for database migration 0168, which is not applied yet.";

function rows(): Waiver[] | null {
  const f = runsFile();
  return f ? ((readRunsFile(f)[TABLE] ?? []) as unknown as Waiver[]) : null;
}

/** The book's waivers, newest first (active and revoked). Empty until 0168 is applied. */
export async function listWaivers(workUid: string): Promise<Waiver[]> {
  const dev = rows();
  if (dev) return dev.filter((w) => w.work_uid === workUid).sort((a, b) => b.id - a.id);
  const { data, error } = await createAdminClient().from(TABLE).select("*").eq("work_uid", workUid).order("id", { ascending: false });
  if (error && missingTable(error)) return [];
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  return (data ?? []) as Waiver[];
}

export type WaiveInput = {
  workUid: string;
  topicId: string;
  topicTitle: string;
  check: string;
  language: string | null;
  subStatus: string | null;
  reason: string;
  by: string;
};

/** Why this waiver may not be recorded, or null. Pure (tested). */
export function refuseWaiver(i: Pick<WaiveInput, "topicId" | "check" | "reason">, active: Pick<Waiver, "topic_id" | "check_code" | "language" | "sub_status">[], language: string | null, subStatus: string | null): string | null {
  if (!UUID.test(i.topicId)) return "Only a topic that exists in the catalogue can have a check waived.";
  if (!/^B([1-9]|1[01])$/.test(i.check)) return "Unknown check.";
  if (i.check === "B1") return "A missing topic cannot be waived: the chapter has nothing to be written from.";
  if (i.reason.trim().length < 10) return "Say why this check should not block the book (at least a sentence).";
  if (active.some((w) => w.topic_id === i.topicId && w.check_code === i.check && (w.language ?? null) === language && (w.sub_status ?? null) === subStatus))
    return "This check is already waived for this book.";
  return null;
}

export async function waiveCheck(i: WaiveInput): Promise<{ ok: true } | { error: string; status: number }> {
  const active = (await listWaivers(i.workUid)).filter((w) => !w.revoked_at);
  const refused = refuseWaiver(i, active, i.language, i.subStatus);
  if (refused) return { error: refused, status: 400 };
  const row = {
    work_uid: i.workUid, topic_id: i.topicId, topic_title: i.topicTitle.slice(0, 300) || null, check_code: i.check,
    language: i.language, sub_status: i.subStatus, reason: i.reason.trim().slice(0, 2000), waived_by: i.by,
  };
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const list = (d[TABLE] ?? []) as unknown as Waiver[];
    const w: Waiver = { ...row, id: list.length + 1, waived_at: new Date().toISOString(), revoked_by: null, revoked_at: null };
    (d as unknown as Record<string, Waiver[]>)[TABLE] = [...list, w];
    writeRunsFile(f, d);
    return { ok: true };
  }
  const { error } = await createAdminClient().from(TABLE).insert(row);
  if (error && missingTable(error)) return { error: NOT_APPLIED, status: 503 };
  if (error?.code === "23505") return { error: "This check is already waived for this book.", status: 409 };
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  return { ok: true };
}

export async function revokeWaiver(i: { workUid: string; id: number; by: string }): Promise<{ ok: true } | { error: string; status: number }> {
  const at = new Date().toISOString();
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const w = ((d[TABLE] ?? []) as unknown as Waiver[]).find((x) => x.id === i.id && x.work_uid === i.workUid);
    if (!w) return { error: "Unknown waiver.", status: 404 };
    if (w.revoked_at) return { error: "This waiver was already revoked.", status: 409 };
    Object.assign(w, { revoked_by: i.by, revoked_at: at });
    writeRunsFile(f, d);
    return { ok: true };
  }
  const { data, error } = await createAdminClient()
    .from(TABLE)
    .update({ revoked_by: i.by, revoked_at: at })
    .eq("id", i.id)
    .eq("work_uid", i.workUid)
    .is("revoked_at", null)
    .select("id");
  if (error && missingTable(error)) return { error: NOT_APPLIED, status: 503 };
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  if (!data?.length) return { error: "Unknown waiver, or it was already revoked.", status: 409 };
  return { ok: true };
}

/** PostgREST's "no such table" (schema cache) or Postgres's undefined_table. */
function missingTable(e: { code?: string; message?: string }): boolean {
  return e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(e.message ?? "");
}
