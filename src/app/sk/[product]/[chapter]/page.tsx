import { notFound } from "next/navigation";
import { skUserAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import SkStudent from "./sk-student";

// SK — the student page (B4 POC). Behind NEXT_PUBLIC_FEATURE_SK: when the
// flag is off the route does not exist. The routes under /api/sk carry the
// authoritative FEATURE_SK check and cookie auth; this page only renders the
// client that talks to them. Products with a graph on this build:
//   /sk/cells-structure-function-organisation/2  (the B3 packager's Chapter 2)
//   /sk/sk-poc-biology/2                         (the one-unit stand-in with check items)
//
// Restricted live (SK_ALLOWED_EMAILS set, founder 2026-10-27): the page is
// 404 for anyone not signed in with a verified address on the list, the same
// 404 the routes answer, so the surface is invisible rather than "forbidden".

export const dynamic = "force-dynamic";

export default async function SkStudentPage({ params }: { params: Promise<{ product: string; chapter: string }> }) {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true") notFound();
  const { product, chapter } = await params;
  const ch = Number(chapter);
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(product) || !Number.isInteger(ch) || ch < 0) notFound();
  if (process.env.SK_ALLOWED_EMAILS) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!skUserAllowed(user)) notFound();
  }
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-3 sm:p-4">
      <SkStudent productId={product} chapter={ch} />
    </main>
  );
}
