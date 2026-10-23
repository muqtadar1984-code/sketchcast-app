import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { ErrorBanner } from "../catalogue-ui";
import { parseBoardParams } from "@/utils/fixes/fix-board";
import { loadFixes } from "./load";
import { AgentHeader, FixesView, Heading } from "./fixes-view";

// /library/fixes — the Fix Agent's cases (migration 0151, Phase 1: failed
// translations). A trend strip (the last 7 days), then the cases grouped by
// cause — filters in the URL (?status=&cause=&lang=&q=&view=), Approve all /
// Retry all per group, a selection bar, and review mode (A / R / J / K).
// A row opens the case in a drawer: what failed, the agent's diagnosis, the
// evidence (English beside the translation), the proposed fix, and — only
// while a case waits for the founder — Approve / Reject. Closed cases stay
// for 30 days. Platform admins only (the `publish` action, like the route):
// an approval lets the worker spend money on a retry.
//
// Rules: utils/fixes/fix-cases.ts + fix-board.ts (tested). Reads: ./load.ts.
// Screen: ./fixes-view.tsx (server) → ./fixes-board.tsx (client). Buttons:
// ./fix-actions.tsx → /api/library/fixes.

export const dynamic = "force-dynamic";

export default async function FixesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
      jobs={load.jobs}
      week={load.week}
      enabled={load.settings?.enabled === true}
      canDecide
      params={parseBoardParams(await searchParams)}
    />
  );
}
