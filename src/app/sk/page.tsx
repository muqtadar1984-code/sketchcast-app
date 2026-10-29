import { notFound } from "next/navigation";
import Link from "next/link";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { skDeps } from "@/sk/server";
import { chaptersFor } from "@/sk/kit-server";
import type { ChapterEntry } from "@/sk/kit-view";
import ChapterLinks from "./chapter-links";

// SK — the learner's front door (the "SK Tutor" dashboard tab). Lists, per
// book, the chapters this learner can open:
//   - S3: the chapters with a MAPPED KIT (sk_product_kits, 0170), when the
//     learner has book access to the product (an unentitled learner sees none
//     of the map). A chapter with several kits lists each.
//   - the chapters this build carries a clip graph for and that have no kit
//     yet (the old clip player; slice E retires it).
// Same gates as the student page, in the same order, so the two surfaces are
// visible to exactly the same people:
//   NEXT_PUBLIC_FEATURE_SK + FEATURE_SK  — the surface exists at all
//   SK_ALLOWED_EMAILS                    — restricted live (founder, 2026-10-27):
//                                           off-list and anonymous ⇒ 404
// Book titles come from sk_book_products through RLS (approved products only);
// a graph whose product is not in the table is still listed by its slug.

export const dynamic = "force-dynamic";

export default async function SkIndexPage() {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true" || !skEnabled()) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (process.env.SK_ALLOWED_EMAILS && !skUserAllowed(user)) notFound();
  if (!user) notFound();
  const t = (await getDictionary(await resolveLocale())).sk.player;

  const deps = await skDeps();
  const clip = new Map<string, number[]>();
  for (const g of deps.graphs) clip.set(g.product_id, [...(clip.get(g.product_id) ?? []), g.chapter]);
  const { data: products } = await supabase.from("sk_book_products").select("slug, title, subject");
  const rows = new Map<string, { slug: string; title: string | null; subject: string | null }>();
  for (const p of (products ?? []) as { slug: string; title: string | null; subject: string | null }[]) rows.set(p.slug, p);
  for (const slug of clip.keys()) if (!rows.has(slug)) rows.set(slug, { slug, title: null, subject: null });

  const books: { slug: string; title: string | null; subject: string | null; entries: ChapterEntry[] }[] = [];
  for (const p of [...rows.values()].sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug))) {
    const entries = await chaptersFor(user.id, p.slug, clip.get(p.slug) ?? []);
    if (entries.length) books.push({ ...p, entries });
  }

  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-[#14181F]">{t.title}</h1>
        <p className="mt-1 text-sm text-[#5B6470]">{t.intro}</p>
        {books.length === 0 ? (
          <p className="mt-6 text-sm text-[#5B6470]">{t.noChapters}</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {books.map((b) => (
              <li key={b.slug} className="rounded-xl border border-[#E3E6E2] bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-[#5B6470]">{b.subject ?? t.bookFallback}</div>
                <Link href={`/sk/${b.slug}`} className="mt-0.5 block font-medium text-[#14181F] underline-offset-2 hover:underline">
                  {b.title ?? b.slug}
                </Link>
                <ChapterLinks slug={b.slug} entries={b.entries} t={t} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
