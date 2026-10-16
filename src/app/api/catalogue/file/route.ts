import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { CATALOGUE_URL_TTL_SECONDS, resolveCatalogueFileWith, type CatalogueStore } from "../logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/catalogue/file?gen={generationId}&kind={docx|answer_key_docx|deck_pptx}
//
// A signed-in teacher's download of one catalogue document (Phase C). Shaped
// after /api/deck/[genId]: session first, service role second, the decision in
// ../logic.ts, a short-lived signed URL carrying the document's download name,
// and a 302 that is never cached. The download is recorded in
// catalogue_events (plan §5.2 — the usage signal the release decision reads).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gen = url.searchParams.get("gen") ?? "";
  const kind = url.searchParams.get("kind") ?? "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "Downloads are unavailable right now." }, 500);
  }

  const result = await resolveCatalogueFileWith(admin as unknown as CatalogueStore, user.id, gen, kind);
  if (!result.ok) return json({ error: result.error }, result.status);

  const { data } = await admin.storage
    .from("artifacts")
    .createSignedUrl(result.path, CATALOGUE_URL_TTL_SECONDS, result.filename ? { download: result.filename } : undefined);
  if (!data?.signedUrl) return json({ error: "The file couldn't load — refresh the page" }, 502);

  // Best-effort: a failed log never fails the download.
  await admin.from("catalogue_events").insert({
    user_id: user.id,
    topic_id: result.topicId,
    event: "download",
    meta: { generation_id: gen, kind: result.genKind, artifact: kind },
  });

  const res = NextResponse.redirect(data.signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function json(body: { error: string }, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
