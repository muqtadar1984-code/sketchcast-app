import "server-only";
import { readChunks, type Admin } from "@/app/api/library/lib";
import { visibleCases, type FixAgentSettings, type FixCase } from "@/utils/fixes/fix-cases";

// Library → Fixes reads (migration 0151): the newest 100 cases, the topic
// titles they name, the names of the people who decided them, and the
// agent's switch. Service role; the page has already checked the member is an
// admin. A database without 0151 answers { ok: false, missing: true }.

const CASE_COLUMNS =
  "id, kind, component, status, round, topic_id, source_kit_id, language, title, issue, source_job_id, evidence, diagnosis, proposal, risk, decided_by, decided_at, decision_note, applied_job_id, applied_at, outcome, history, cost_usd, created_at, updated_at, resolved_at";
const LIMIT = 100;

export type FixesLoad =
  | { ok: true; cases: FixCase[]; topics: Record<string, string>; people: Record<string, string>; settings: FixAgentSettings | null; nowMs: number }
  | { ok: false; missing: true }
  | { ok: false; missing?: false; error: string };

const tableMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /fix_cases/.test(e.message ?? ""));

export async function loadFixes(admin: Admin, nowMs: number = Date.now()): Promise<FixesLoad> {
  const [casesQ, settingsQ] = await Promise.all([
    admin.from("fix_cases").select(CASE_COLUMNS).order("updated_at", { ascending: false }).limit(LIMIT),
    admin.from("platform_settings").select("value").eq("key", "fix_agent").maybeSingle(),
  ]);
  if (tableMissing(casesQ.error)) return { ok: false, missing: true };
  if (casesQ.error) return { ok: false, error: casesQ.error.message ?? "unknown database error" };
  if (settingsQ.error) return { ok: false, error: settingsQ.error.message ?? "unknown database error" };

  const cases = visibleCases((casesQ.data ?? []) as FixCase[], nowMs);

  const topicIds = [...new Set(cases.map((c) => c.topic_id).filter((v): v is string => !!v))];
  const topicsQ = await readChunks<{ id: string; title: string }>(topicIds, (chunk) => admin.from("topics").select("id, title").in("id", chunk));
  if (topicsQ.error) return { ok: false, error: topicsQ.error.message ?? "unknown database error" };

  const personIds = [
    ...new Set(
      cases
        .flatMap((c) => [c.decided_by, ...(Array.isArray(c.history) ? c.history.map((h) => h?.decided_by) : [])])
        .filter((v): v is string => typeof v === "string" && !!v),
    ),
  ];
  // names are a nicety: a failed read shows the id instead
  const peopleQ = await readChunks<{ id: string; full_name: string | null }>(personIds, (chunk) => admin.from("profiles").select("id, full_name").in("id", chunk));

  return {
    ok: true,
    cases,
    topics: Object.fromEntries(topicsQ.rows.map((t) => [t.id, t.title])),
    people: Object.fromEntries(peopleQ.rows.filter((p) => p.full_name).map((p) => [p.id, p.full_name as string])),
    settings: (settingsQ.data?.value ?? null) as FixAgentSettings | null,
    nowMs,
  };
}
