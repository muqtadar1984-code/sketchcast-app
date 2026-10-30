import { notFound } from "next/navigation";
import Link from "next/link";
import { skAccessAllowed, skEnabled } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { chaptersFor } from "@/sk/kit-server";
import ChapterLinks from "../chapter-links";

// SK — one book's chapters (SK S3 slice B): the chapters with a mapped kit
// (when the learner has book access), exactly as the /sk front door lists
// them for this book. Same gates as /sk.

export const dynamic = "force-dynamic";

export default async function SkProductPage({ params }: { params: Promise<{ product: string }> }) {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true" || !skEnabled()) notFound();
  const { product } = await params;
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(product)) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!(await skAccessAllowed(user))) notFound();
  if (!user) notFound();
  const t = (await getDictionary(await resolveLocale())).sk.player;

  const entries = await chaptersFor(user.id, product);
  const { data: row } = await supabase.from("sk_book_products").select("title, subject").eq("slug", product).maybeSingle();

  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <Link href="/sk" className="inline-flex min-h-10 items-center text-sm text-[#0C8175] underline-offset-2 hover:underline">
          {t.allChapters}
        </Link>
        <div className="mt-2 text-xs uppercase tracking-wide text-[#5B6470]">{(row?.subject as string | null) ?? t.bookFallback}</div>
        <h1 className="text-2xl font-semibold text-[#14181F]">{(row?.title as string | null) ?? product}</h1>
        {entries.length === 0 ? <p className="mt-6 text-sm text-[#5B6470]">{t.noChapters}</p> : <ChapterLinks slug={product} entries={entries} t={t} />}
      </div>
    </main>
  );
}
