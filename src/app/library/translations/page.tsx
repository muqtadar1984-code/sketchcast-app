import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { parseMatrixFilters, translationLanguages } from "@/utils/catalogue/translation-matrix";
import { ErrorBanner } from "../catalogue-ui";
import { loadTranslationMatrix } from "./load";
import { Heading, TranslationsView } from "./translations-view";

// /library/translations — the Translations tab (2026-10-18): every topic
// against every lesson language, so "which one was done, which was not and
// which language was missed" is one screen. Rows: topics, by subject then
// title. Columns: the English source kit, then the translation languages in
// the Kit Translator's order (Arabic first). Each cell links to the review
// inbox on that topic and language. Read-only — queueing stays in the inbox's
// Translate… drawer. Visible to every Library member.
//
// The cell rules live in utils/catalogue/translation-matrix.ts (tested); the
// reads in ./load.ts (the sweep's reads, widened to every topic and language);
// the screen in ./translations-view.tsx.

export const dynamic = "force-dynamic";

export default async function TranslationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireLibraryMember();
  const languages = translationLanguages();
  const filters = parseMatrixFilters(await searchParams, languages);
  const load = await loadTranslationMatrix(createAdminClient());
  if (!load.ok) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={load.error} />
      </main>
    );
  }
  return <TranslationsView load={load} filters={filters} languages={languages} />;
}
