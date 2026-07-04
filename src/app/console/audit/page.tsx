import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// The ops audit trail (platform_audit_log) — every staff write, newest first.
// Sparse until the ops phase lands; issue-status changes write here already.

export const dynamic = "force-dynamic";

type LogRow = {
  id: string;
  actor_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export default async function ConsoleAuditPage() {
  const admin = createAdminClient();
  const { data: logRaw } = await admin
    .from("platform_audit_log")
    .select("id, actor_id, action, target_kind, target_id, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  const log = (logRaw ?? []) as LogRow[];

  const actorIds = [...new Set(log.map((l) => l.actor_id).filter(Boolean))] as string[];
  const { data: profs } = actorIds.length
    ? await admin.from("profiles").select("id, full_name, username").in("id", actorIds)
    : { data: [] };
  const nameOf = new Map((profs ?? []).map((p) => [p.id, p.full_name || p.username || "Staff"] as const));

  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Audit</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-6">Every staff action, newest first. Append-only.</p>

      {log.length === 0 ? (
        <div className="card px-5 py-6 text-sm text-[#5B6470]">No staff actions recorded yet.</div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC]">
          {log.map((l) => (
            <div key={l.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{l.actor_id ? nameOf.get(l.actor_id) ?? "Staff" : "System"}</span>
                <span className="text-[#5B6470]"> · {l.action}</span>
                {l.target_kind && <span className="text-[#98A0A9]"> → {l.target_kind}</span>}
                {l.detail && Object.keys(l.detail).length > 0 && (
                  <span className="text-xs text-[#98A0A9]"> · {JSON.stringify(l.detail).slice(0, 80)}</span>
                )}
              </span>
              <span className="tabular shrink-0 text-xs text-[#5B6470]">{new Date(l.created_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
