import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { translationLanguages } from "@/utils/catalogue/translation-matrix";
import { parseVideoFilters } from "@/utils/catalogue/youtube-videos";
import { ErrorBanner } from "../../catalogue-ui";
import { Heading } from "../translations-view";
import { TranslationsNav } from "../sub-nav";
import { loadTranslatedVideos } from "./load";
import { YouTubeVideosView } from "./youtube-view";

// /library/translations/youtube — the Translations tab's second view
// (2026-10-20): every translated video and where it stands on YouTube —
// posted (public / unlisted / private) or not posted (ready, posting, failed,
// awaiting approval, no channel yet) — in one list. Read-only, for every
// Library member; posting stays in the review inbox, admin only.
//
// Rules: utils/catalogue/youtube-videos.ts (tested). Reads: ./load.ts.
// Screen: ./youtube-view.tsx. Plan: "SketchCast Feature Plan - Translated
// Videos YouTube Tab.md".

export const dynamic = "force-dynamic";

export default async function TranslatedVideosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // the reads below use the service role: authenticate here, not only in the layout
  await requireLibraryMember();
  const filters = parseVideoFilters(await searchParams, translationLanguages());
  const load = await loadTranslatedVideos(createAdminClient());
  if (!load.ok) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <TranslationsNav active="youtube" />
        <ErrorBanner message={load.error} />
      </main>
    );
  }
  return <YouTubeVideosView input={load.input} filters={filters} />;
}
