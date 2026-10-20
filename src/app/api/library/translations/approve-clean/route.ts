import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { requestLandingRebuild } from "@/utils/catalogue/landing";
import { translationAcceptsApprove } from "@/utils/catalogue/kit";
import { cleanVerdict, generationIdsOf, type CleanKit, type CleanSource } from "@/utils/catalogue/auto-translate";
import { LANGUAGES } from "@/utils/narration";
import { audit, bad, dbError, notFound, readChunks, readJson } from "../../lib";

export const runtime = "nodejs";

// "Approve all clean" (Auto Translate Agent plan §5.2 — founder, 2026-10-20):
// one click per language approves every in-review translation that is CLEAN —
// pre-checks passed with no blocking finding, every piece its English source
// has present and done (utils/catalogue/auto-translate.ts cleanVerdict). The
// rest stay in review for a one-by-one look, each with its reason.
//
//   POST {language, dryRun: true}       → {language, clean[], notClean[]}
//   POST {language, kitIds?}            → approve the clean ones (the kitIds the
//        dry run showed, when given — a kit that stopped being clean in between
//        is skipped), at most MAX_PER_CLICK, through the SAME path as the kit
//        route's single approve: translationAcceptsApprove, then the
//        approve_topic_kit RPC (which audits library_kit_translation_approve on
//        the topic), then ONE landing rebuild.
//
// Approving makes a translation live in the app at once (the catalogue is
// public), so the panel's confirm says so. Reviewers, editors and admins
// (`approve`), like the single approve.

type Body = { language?: unknown; dryRun?: unknown; kitIds?: unknown };

/** Approvals per click: each is one RPC; a long language list finishes over
 *  a few clicks rather than racing the function's time limit. */
const MAX_PER_CLICK = 40;

const NOTES = "Approve all clean (bulk)";
const KIT_COLUMNS = "id, topic_id, article_id, language, status, translation_status, precheck, source_kit_id, presentation_generation_id, doc_generation_ids";

type Row = CleanKit & { article_id: string; source_kit_id: string | null };
type Listed = { kitId: string; topicId: string; title: string };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("approve");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const language = typeof body.language === "string" ? body.language : "";
  if (language === "en" || !LANGUAGES.some((l) => l.value === language)) return bad("Choose a translation language.");
  const admin = createAdminClient();

  const kitsQ = await admin.from("topic_kits").select(KIT_COLUMNS).eq("language", language).eq("translation_status", "in_review");
  if (kitsQ.error) return dbError(kitsQ.error);
  const kits = (kitsQ.data ?? []) as Row[];

  const sourceIds = [...new Set(kits.map((k) => k.source_kit_id).filter((v): v is string => !!v))];
  const sources = await readChunks<CleanSource & { id: string }>(sourceIds, (c) =>
    admin.from("topic_kits").select("id, presentation_generation_id, doc_generation_ids").in("id", c),
  );
  if (sources.error) return dbError(sources.error);
  const sourceById = new Map(sources.rows.map((s) => [s.id, s]));

  const genIds = generationIdsOf([...kits, ...sources.rows]);
  const gens = await readChunks<{ id: string; status: string }>(genIds, (c) => admin.from("generations").select("id, status").in("id", c));
  if (gens.error) return dbError(gens.error);
  const genStatus = new Map(gens.rows.map((g) => [g.id, g.status]));

  const topicIds = [...new Set(kits.map((k) => k.topic_id))];
  const topics = await readChunks<{ id: string; title: string; status: string }>(topicIds, (c) =>
    admin.from("topics").select("id, title, status").in("id", c),
  );
  if (topics.error) return dbError(topics.error);
  const topicById = new Map(topics.rows.map((t) => [t.id, t]));

  const clean: (Listed & { row: Row })[] = [];
  const notClean: (Listed & { why: string })[] = [];
  for (const k of kits) {
    const listed = { kitId: k.id, topicId: k.topic_id, title: topicById.get(k.topic_id)?.title ?? k.topic_id };
    const v = cleanVerdict(k, k.source_kit_id ? sourceById.get(k.source_kit_id) ?? null : null, genStatus);
    if (v.clean) clean.push({ ...listed, row: k });
    else notClean.push({ ...listed, why: v.why });
  }
  clean.sort((a, b) => a.title.localeCompare(b.title));
  notClean.sort((a, b) => a.title.localeCompare(b.title));
  const strip = (r: Listed) => ({ kitId: r.kitId, topicId: r.topicId, title: r.title });

  if (body.dryRun === true) {
    return NextResponse.json({ language, clean: clean.map(strip), notClean, maxPerClick: MAX_PER_CLICK });
  }

  const wanted = Array.isArray(body.kitIds) ? new Set(body.kitIds.filter((x): x is string => typeof x === "string")) : null;
  const batch = clean.filter((c) => !wanted || wanted.has(c.kitId)).slice(0, MAX_PER_CLICK);

  const articleIds = [...new Set(batch.map((c) => c.row.article_id))];
  const articles = await readChunks<{ id: string; status: string }>(articleIds, (c) => admin.from("topic_articles").select("id, status").in("id", c));
  if (articles.error) return dbError(articles.error);
  const articleStatus = new Map(articles.rows.map((a) => [a.id, a.status]));

  const approved: Listed[] = [];
  const failed: (Listed & { why: string })[] = [];
  for (const c of batch) {
    const accepts = translationAcceptsApprove(c.row.status, c.row.translation_status, articleStatus.get(c.row.article_id) ?? null,
      topicById.get(c.row.topic_id)?.status ?? "retired");
    if (!accepts.ok) {
      failed.push({ ...strip(c), why: accepts.why });
      continue;
    }
    const { error } = await admin.rpc("approve_topic_kit", { p_kit: c.kitId, p_reviewer: m.id, p_notes: NOTES });
    if (error) failed.push({ ...strip(c), why: error.message ?? "the approval was refused" });
    else approved.push(strip(c));
  }
  // each kit is audited by the RPC (library_kit_translation_approve on its
  // topic); this row records the click itself
  await audit(admin, m.id, "kit_translation_approve_clean", "translations", null, {
    language,
    bulk: true,
    approved: approved.map((a) => a.kitId),
    failed: failed.map((f) => ({ kitId: f.kitId, why: f.why })),
  });
  if (approved.length) await requestLandingRebuild("kit_approve");
  const left = clean.filter((c) => !wanted || wanted.has(c.kitId)).length - batch.length;
  return NextResponse.json({ language, approved, failed, left: Math.max(0, left), notClean });
}
