import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { ErrorBanner } from "../catalogue-ui";
import { loadFixes } from "./load";
import { AgentHeader, FixesView, Heading } from "./fixes-view";

// /library/fixes — the Fix Agent's cases (migration 0151, Phase 1: failed
// translations). One card per case: what failed, the agent's diagnosis, the
// evidence (English beside the translation), the proposed fix, and — only
// while a case waits for the founder — Approve / Reject. Closed cases stay
// for 30 days. Platform admins only (the `publish` action, like the route):
// an approval lets the worker spend money on a retry.
//
// Rules: utils/fixes/fix-cases.ts (tested). Reads: ./load.ts. Screen:
// ./fixes-view.tsx. Buttons: ./fix-actions.tsx → /api/library/fixes.

export const dynamic = "force-dynamic";

export default async function FixesPage() {
  // the reads below use the service role: authenticate here, not only in the layout
  const m = await requireLibraryMember();
  if (!libraryAllows(m.role, "publish")) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <p className="text-sm text-[#5B6470]">Fixes are for platform admins.</p>
      </main>
    );
  }

  const load = await loadFixes(createAdminClient());
  if (!load.ok) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <AgentHeader enabled={false} available={false} />
        <ErrorBanner message={load.missing ? "Needs migration 0151 (0151_fix_agent.sql) — the Fix Agent's table is not in this database yet." : load.error} />
      </main>
    );
  }

  return (
    <FixesView
      cases={load.cases}
      topics={load.topics}
      people={load.people}
      enabled={load.settings?.enabled === true}
      canDecide
    />
  );
}
