import { notFound } from "next/navigation";
import SkStudent from "./sk-student";

// SK — the student page (B4 POC). Behind NEXT_PUBLIC_FEATURE_SK: when the
// flag is off the route does not exist. The routes under /api/sk carry the
// authoritative FEATURE_SK check and cookie auth; this page only renders the
// client that talks to them. Products with a graph on this build:
//   /sk/cells-structure-function-organisation/2  (the B3 packager's Chapter 2)
//   /sk/sk-poc-biology/2                         (the one-unit stand-in with check items)

export const dynamic = "force-dynamic";

export default async function SkStudentPage({ params }: { params: Promise<{ product: string; chapter: string }> }) {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true") notFound();
  const { product, chapter } = await params;
  const ch = Number(chapter);
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(product) || !Number.isInteger(ch) || ch < 0) notFound();
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-3 sm:p-4">
      <SkStudent productId={product} chapter={ch} />
    </main>
  );
}
