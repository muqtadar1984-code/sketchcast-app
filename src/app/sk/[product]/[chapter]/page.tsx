import Link from "next/link";
import { notFound } from "next/navigation";
import { skUserAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { chapterHasKit } from "@/sk/kit-server";
import KitPlayer from "./kit-player";

// SK — the student page. Behind NEXT_PUBLIC_FEATURE_SK: when the flag is off
// the route does not exist. The routes under /api/sk carry the authoritative
// FEATURE_SK check and cookie auth; this page only picks which client to mount:
//
//   1. S3: the chapter has a MAPPED KIT (sk_product_kits) → the kit player,
//      on ?kit=<generation id> when given (a chapter may have several kits).
//      Every refusal (not entitled / not mapped / no kit) is the API's.
//   2. Otherwise: "this chapter doesn't have a lesson yet". (The old packager
//      clip player that used to sit here was retired in S3 slice E.)
//
// Restricted live (SK_ALLOWED_EMAILS set, founder 2026-10-27): the page is
// 404 for anyone not signed in with a verified address on the list, the same
// 404 the routes answer, so the surface is invisible rather than "forbidden".

export const dynamic = "force-dynamic";

const PRODUCT_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const CHAPTER_RE = /^[A-Za-z0-9._-]{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SkStudentPage({ params, searchParams }: { params: Promise<{ product: string; chapter: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true") notFound();
  const { product, chapter: rawChapter } = await params;
  let chapter = rawChapter;
  try {
    chapter = decodeURIComponent(rawChapter);
  } catch {
    notFound();
  }
  if (!PRODUCT_RE.test(product) || !CHAPTER_RE.test(chapter)) notFound();
  const sp = await searchParams;
  const kitParam = typeof sp.kit === "string" && UUID_RE.test(sp.kit) ? sp.kit : null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (process.env.SK_ALLOWED_EMAILS && !skUserAllowed(user)) notFound();
  const locale = await resolveLocale();

  if (user && (await chapterHasKit(product, chapter))) {
    const t = (await getDictionary(locale)).sk.player;
    return (
      <main className="min-h-screen bg-[#F6F7F5] p-3 sm:p-4">
        <div className="mx-auto mb-2 max-w-3xl">
          <Link href={`/sk/${product}`} className="inline-flex min-h-10 items-center text-sm text-[#0C8175] underline-offset-2 hover:underline">
            {t.allChapters}
          </Link>
        </div>
        <KitPlayer product={product} chapter={chapter} initialKit={kitParam} locale={locale} t={t} />
      </main>
    );
  }

  const t = (await getDictionary(locale)).sk.player;
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-3 sm:p-4">
      <div className="mx-auto max-w-3xl rounded-xl border border-[#E3E6E2] bg-white p-4 text-sm text-[#14181F]" role="status">
        {t.refusedNoKit}
        <div className="mt-3">
          <Link href={`/sk/${product}`} className="inline-flex min-h-10 items-center text-sm text-[#0C8175] underline-offset-2 hover:underline">
            {t.allChapters}
          </Link>
        </div>
      </div>
    </main>
  );
}
