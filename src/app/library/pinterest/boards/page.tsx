import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import type { BoardStatus } from "@/utils/catalogue/pinterest";
import { ErrorBanner } from "../../catalogue-ui";
import { languageName, MissingPinterestBanner, PinterestHeading, PinterestNav } from "../chrome";
import { BoardRow } from "../controls";
import { loadPinterest } from "../load";

// /library/pinterest/boards — the account's boards (decision D2: one account,
// boards per language × subject). Planned boards are edited and approved
// here; the worker creates an approved board on Pinterest and records its id.
// Names are written once by a person, not generated per pin.

export const dynamic = "force-dynamic";

const STATUS: Record<BoardStatus, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "bg-[#EEF0EC] text-[#5B6470]" },
  approved: { label: "Approved — waiting for the worker", tone: "bg-[#FFF1D6] text-[#9A6400]" },
  created: { label: "On Pinterest", tone: "bg-[#E6F6F2] text-[#0F7A68]" },
  archived: { label: "Archived", tone: "bg-[#EEF0EC] text-[#5B6470]" },
};

export default async function PinterestBoardsPage() {
  const member = await requireLibraryMember();
  const admin = createAdminClient();
  let load;
  try {
    load = await loadPinterest(admin);
  } catch (e) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="boards" />
        <ErrorBanner message={e instanceof Error ? e.message : "Could not load the boards."} />
      </main>
    );
  }
  if (!load.available) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="boards" />
        <MissingPinterestBanner />
      </main>
    );
  }
  const canAct = libraryAllows(member.role, "publish");
  const byLanguage = new Map<string, typeof load.boards>();
  for (const b of load.boards) byLanguage.set(b.language, [...(byLanguage.get(b.language) ?? []), b]);

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
      <div>
        <PinterestHeading settings={load.settings} />
        <PinterestNav active="boards" counts={load.counts} />
      </div>
      {load.boards.length === 0 ? <p className="text-sm text-[#5B6470]">No boards planned yet.</p> : null}
      {[...byLanguage.entries()].map(([language, boards]) => (
        <section key={language} className="space-y-2">
          <h2 className="font-medium">{languageName(language)}</h2>
          <ul className="divide-y divide-[#EEF0EC] rounded-xl border border-[#E3E6E0] bg-white">
            {boards.map((b) => (
              <li key={b.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <BoardRow board={b} canAct={canAct} />
                <div className="text-xs sm:text-right space-y-1">
                  <span className={`chip ${STATUS[b.status].tone}`}>{STATUS[b.status].label}</span>
                  <p className="text-[#98A0A9] font-mono">{b.board_key}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
