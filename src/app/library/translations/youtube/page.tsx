import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { translationLanguages } from "@/utils/catalogue/translation-matrix";
import { buildVideoRows, parseVideoFilters, type VideoRow } from "@/utils/catalogue/youtube-videos";
import { OPEN_STATUSES } from "@/utils/catalogue/youtube-agent";
import { ErrorBanner } from "../../catalogue-ui";
import { Heading } from "../translations-view";
import { TranslationsNav } from "../sub-nav";
import { loadTranslatedVideos } from "./load";
import { loadPublishAgent } from "./agent-load";
import { AgentSection } from "./agent-section";
import { SelectAllBox, SelectBox, SelectionProvider } from "./agent-ui";
import { YouTubeVideosView } from "./youtube-view";

// /library/translations/youtube — the Translations tab's second view
// (2026-10-20): every translated video and where it stands on YouTube —
// posted (public / unlisted / private) or not posted (ready, posting, failed,
// awaiting approval, no channel yet) — in one list, for every Library member.
//
// The YouTube Publishing Agent (2026-10-21, migration 0150): platform admins
// tick ready rows and add them to the posting queue; the worker posts one
// video per language per day, and "Run once more" asks for another round.
// The panel shows for every member; the boxes and buttons for admins only.
//
// Rules: utils/catalogue/youtube-videos.ts and youtube-agent.ts (tested).
// Reads: ./load.ts, ./agent-load.ts. Screen: ./youtube-view.tsx.

export const dynamic = "force-dynamic";

export default async function TranslatedVideosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // the reads below use the service role: authenticate here, not only in the layout
  const member = await requireLibraryMember();
  const filters = parseVideoFilters(await searchParams, translationLanguages());
  const admin = createAdminClient();
  const [load, agent] = await Promise.all([loadTranslatedVideos(admin), loadPublishAgent(admin).catch(() => ({ available: false as const }))]);
  if (!load.ok) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <TranslationsNav active="youtube" />
        <ErrorBanner message={load.error} />
      </main>
    );
  }

  const nowMs = load.input.nowMs;
  const canControl = libraryAllows(member.role, "publish") && agent.available;
  const rows = buildVideoRows(load.input);
  const queued = new Set(agent.available ? agent.open.filter((i) => (OPEN_STATUSES as readonly string[]).includes(i.status)).map((i) => i.kit_id) : []);
  const why = (r: VideoRow): string | null => (queued.has(r.kitId) ? "Already in the posting queue." : r.postable.ok ? null : r.postable.why);

  const view = (
    <YouTubeVideosView
      input={load.input}
      filters={filters}
      top={<AgentSection agent={agent} rows={rows} nowMs={nowMs} canControl={canControl} />}
      selection={
        canControl
          ? {
              header: (listed) => <SelectAllBox kitIds={listed.filter((r) => why(r) === null).map((r) => r.kitId)} />,
              cell: (r) => <SelectBox kitId={r.kitId} disabledWhy={why(r)} label={`${r.title} (${r.languageName})`} />,
            }
          : undefined
      }
    />
  );
  return canControl ? <SelectionProvider>{view}</SelectionProvider> : view;
}
