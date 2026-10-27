import Link from "next/link";
import { notFound } from "next/navigation";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import { skDeps } from "@/sk/server";

// SK — the learner's front door (the "SK Tutor" dashboard tab). Lists every
// chapter this build carries a teaching graph for, grouped by book, and links
// to the student page. Same gates as that page, in the same order, so the two
// surfaces are visible to exactly the same people:
//   NEXT_PUBLIC_FEATURE_SK + FEATURE_SK  — the surface exists at all
//   SK_ALLOWED_EMAILS                    — restricted live (founder, 2026-10-27):
//                                           off-list and anonymous ⇒ 404
// Book titles come from sk_book_products through RLS (approved products only);
// a graph whose product is not in the table is still listed by its slug, so a
// packaged chapter never vanishes from this page over a missing row.

export const dynamic = "force-dynamic";

export default async function SkIndexPage() {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true" || !skEnabled()) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (process.env.SK_ALLOWED_EMAILS && !skUserAllowed(user)) notFound();
  if (!user) notFound();

  const deps = await skDeps();
  const chapters = deps.graphs
    .map((g) => ({ product: g.product_id, chapter: g.chapter, units: g.units.length }))
    .sort((a, b) => a.product.localeCompare(b.product) || a.chapter - b.chapter);
  const slugs = [...new Set(chapters.map((c) => c.product))];
  const { data: products } = slugs.length
    ? await supabase.from("sk_book_products").select("slug, title, subject").in("slug", slugs)
    : { data: [] as { slug: string; title: string; subject: string | null }[] };
  const titleOf = new Map((products ?? []).map((p) => [p.slug, p]));

  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-[#14181F]">SK Tutor</h1>
        <p className="mt-1 text-sm text-[#5B6470]">
          Pick a chapter. SK teaches it on the board, answers your questions, and checks what you have learned.
        </p>
        {chapters.length === 0 ? (
          <p className="mt-6 text-sm text-[#5B6470]">No chapters are ready on this build yet.</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {slugs.map((slug) => {
              const p = titleOf.get(slug);
              return (
                <li key={slug} className="rounded-xl border border-[#E3E6E2] bg-white p-4">
                  <div className="text-xs uppercase tracking-wide text-[#5B6470]">{p?.subject ?? "Book"}</div>
                  <div className="mt-0.5 font-medium text-[#14181F]">{p?.title ?? slug}</div>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {chapters
                      .filter((c) => c.product === slug)
                      .map((c) => (
                        <li key={c.chapter}>
                          <Link
                            href={`/sk/${slug}/${c.chapter}`}
                            className="inline-block rounded-lg border border-[#14181F] px-3 py-1.5 text-sm text-[#14181F] hover:bg-[#14181F] hover:text-white"
                          >
                            Chapter {c.chapter} · {c.units} units
                          </Link>
                        </li>
                      ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
