import { skRedirect } from "../redirect";

// SK Tutor is retired (founder 2026-10-31): a bookmarked book opens on the
// Classroom Board for an adult the Board admits, else /dashboard (redirect-path.ts).

export const dynamic = "force-dynamic";

export default async function SkProductPage({ params }: { params: Promise<{ product: string }> }): Promise<never> {
  const { product } = await params;
  return skRedirect(product);
}
