import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import type { Blueprint } from "@/utils/catalogue/questions";
import { ErrorBanner, MissingTablesBanner, ReadOnlyNote } from "../catalogue-ui";
import { BlueprintsPanel } from "./blueprints-panel";

// /library/blueprints — the composer's presets (0112 question_set_blueprints;
// Phase 3, spec decision 9): what a worksheet is made of — how many items,
// the objective / subjective split, the difficulty mix, the marks — and the
// bank maturity a topic needs before the preset is offered. Curators create,
// edit, retire and reactivate them; every topic's Compose box reads the
// active ones. Nothing is ever deleted (question_sets point at blueprints
// with `on delete restrict`).

export const dynamic = "force-dynamic";

const BLUEPRINT_COLUMNS = "id, name, scope, curriculum_id, spec, min_maturity, status, created_by, created_at";

export default async function BlueprintsPage() {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const admin = createAdminClient();

  const [bpQ, setsQ] = await Promise.all([
    admin.from("question_set_blueprints").select(BLUEPRINT_COLUMNS).order("status", { ascending: true }).order("name", { ascending: true }),
    // How often each preset has been composed — the table says "used 3×" so a
    // curator knows what retiring one affects (the sets themselves stay).
    admin.from("question_sets").select("blueprint_id").limit(5000),
  ]);
  if (catalogueMissing(bpQ.error)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="question_set_blueprints" />
      </main>
    );
  }
  if (bpQ.error) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the blueprints: ${bpQ.error.message}`} />
      </main>
    );
  }
  const blueprints = (bpQ.data ?? []) as unknown as Blueprint[];
  const uses: Record<string, number> = {};
  for (const s of (setsQ.data ?? []) as { blueprint_id: string }[]) uses[s.blueprint_id] = (uses[s.blueprint_id] ?? 0) + 1;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Heading />
        <p className="text-sm text-[#5B6470] mt-2">
          {blueprints.filter((b) => b.status === "active").length} active · {blueprints.filter((b) => b.status !== "active").length} retired
        </p>
      </div>
      <p className="text-[#5B6470] mb-5">
        A blueprint is a recipe for a worksheet: <span className="font-medium">count</span> items, an <span className="font-medium">objective ratio</span>{" "}
        (the share marked without judgement), a <span className="font-medium">difficulty mix</span> over 1–5 that adds up to 1, the{" "}
        <span className="font-medium">total marks</span>, and the <span className="font-medium">bank maturity</span> a topic needs first. The worker fills
        every bucket exactly from a topic&apos;s approved items — never padding — so a topic&apos;s Compose box greys a preset its bank cannot satisfy yet.
      </p>
      {!canCurate && <ReadOnlyNote what="editing blueprints" />}
      {setsQ.error && <ErrorBanner message={`Could not count the sets: ${setsQ.error.message}`} />}
      <BlueprintsPanel blueprints={blueprints} uses={uses} canCurate={canCurate} />
    </main>
  );
}

function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Blueprints</h1>
      <InkUnderline className="block h-3 w-36 mb-3" color="#7FD8A8" />
    </div>
  );
}
