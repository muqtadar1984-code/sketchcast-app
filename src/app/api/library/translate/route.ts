import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { catalogueGenerateEnabled } from "@/utils/flags";
import { catalogueColumnMissing } from "@/utils/catalogue/status";
import { LANGUAGES } from "@/utils/narration";
import {
  SWEEP_DEFAULT_LIMIT,
  SWEEP_MAX_LIMIT,
  readyForTranslation,
  type SweepCandidate,
  type SweepCurrentKit,
  type SweepInput,
  type SweepJob,
  type SweepKit,
  type SweepPublication,
  type SweepTopic,
} from "@/utils/catalogue/translate-sweep";
import { audit, bad, conflict, dbError, notFound, readChunks, readJson, type Admin } from "../lib";
import { enqueueTranslateJob } from "../topics/[id]/kit/translate-job";

export const runtime = "nodejs";

// The Kit Translator's SWEEP (plan §5.8 + decision D7, T2 — 2026-10-17): the
// bulk button per language. The founder's ask: "five kits first, then the
// rest", seeing exactly which kits will be queued and why the others are not
// ready.
//
//   GET  ?language=ar            the dry run: {language, ready, notReady}
//   POST {language, limit, dryRun?}
//        dryRun: the same answer as GET;
//        otherwise ONE `kit_translate` observer job per ready kit, up to
//        `limit` (default 5, capped SWEEP_MAX_LIMIT), through the kit route's
//        own translate-job.ts — a live job for the same (source kit, language)
//        is reported as alreadyQueued, never as new — answering
//        {language, queued, alreadyQueued, skipped, remaining, notReady}.
//
// What is READY is decided by the pure readyForTranslation() over five reads:
// catalogue_current_kits() (the current English kit per topic), the topics,
// the kits (the current English ones and every kit of their topics in the
// target language), the publications (part 1 public on YouTube), and the
// live translate jobs. The route decides nothing itself.
//
// Same gates as the kit route's translate action: a member who may
// `generate`, behind FEATURE_CATALOGUE_GENERATE (the render spends the kit
// lane's hours). The WORKER serialises the jobs — one kit at a time on the
// catalogue lane, in its off-peak window — and refuses what this route would
// have refused (decision 13). This route writes nothing but the jobs (through
// translate-job.ts) and the audit rows: one library_kit_translate_sweep per
// queued kit on its topic, carrying the whole sweep, so each topic's History
// shows the sweep it was part of.

type Body = { language?: unknown; limit?: unknown; dryRun?: unknown };

const LANGUAGE = "en";

const KIT_COLUMNS = "id, topic_id, language, status, source_kit_id, judge_score, created_at";
const KIT_COLUMNS_0134 = `${KIT_COLUMNS}, translation_status, supersede_reason`;
const PUBLICATION_COLUMNS = "topic_kit_id, part, privacy, youtube_video_id";
const PUBLICATION_COLUMNS_0122 = `${PUBLICATION_COLUMNS}, superseded_by`;

function languageOf(v: unknown): string | null {
  const language = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!language || !LANGUAGES.some((l) => l.value === language) || language === LANGUAGE) return null;
  return language;
}

function limitOf(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return SWEEP_DEFAULT_LIMIT;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > SWEEP_MAX_LIMIT) return null;
  return n;
}

/** The five reads, or the response that stops the sweep. */
async function loadSweep(admin: Admin, language: string): Promise<{ input: SweepInput; response: null } | { input: null; response: NextResponse }> {
  const { data: currentRows, error: cErr } = await admin.rpc("catalogue_current_kits");
  if (cErr) return { input: null, response: dbError(cErr) };
  const current = ((currentRows ?? []) as SweepCurrentKit[]).filter((r) => r.language === LANGUAGE);
  const topicIds = [...new Set(current.map((r) => r.topic_id))];
  const kitIds = new Set(current.map((r) => r.topic_kit_id));

  const topics = await readChunks<SweepTopic>(topicIds, (chunk) => admin.from("topics").select("id, title, subject, status, bank_maturity").in("id", chunk));
  if (topics.error) return { input: null, response: dbError(topics.error) };

  // the current English kits and the topics' kits in the target language —
  // with 0134's columns, which the readiness rule needs (a database without
  // them cannot run the Kit Translator at all, so that is a 409, not a fallback)
  const kitsRead = await readChunks<SweepKit>(topicIds, (chunk) => admin.from("topic_kits").select(KIT_COLUMNS_0134).in("topic_id", chunk).in("language", [LANGUAGE, language]));
  if (kitsRead.error && catalogueColumnMissing(kitsRead.error)) {
    return { input: null, response: conflict("The translation columns are not in this database yet — apply migration 0134.", { migration: "0134_kit_translator.sql" }) };
  }
  if (kitsRead.error) return { input: null, response: dbError(kitsRead.error) };
  const kits = kitsRead.rows.filter((k) => k.language !== LANGUAGE || kitIds.has(k.id));

  // part 1 public on YouTube; superseded_by is 0122's — read without it when
  // a database does not carry it (every part-1 video then counts as live)
  const pubIds = [...kitIds];
  let publications = await readChunks<SweepPublication>(pubIds, (chunk) => admin.from("topic_publications").select(PUBLICATION_COLUMNS_0122).in("topic_kit_id", chunk));
  if (publications.error && catalogueColumnMissing(publications.error)) {
    publications = await readChunks<SweepPublication>(pubIds, (chunk) => admin.from("topic_publications").select(PUBLICATION_COLUMNS).in("topic_kit_id", chunk));
  }
  if (publications.error) return { input: null, response: dbError(publications.error) };

  const { data: jobRows, error: jErr } = await admin
    .from("jobs")
    .select("id, status, params")
    .eq("type", "kit_translate")
    .in("status", ["queued", "processing"])
    .limit(500);
  if (jErr) return { input: null, response: dbError(jErr) };

  return {
    input: { current, topics: topics.rows, kits, publications: publications.rows, jobs: (jobRows ?? []) as SweepJob[] },
    response: null,
  };
}

const dryRun = (language: string, input: SweepInput) => {
  const r = readyForTranslation(input, language);
  return NextResponse.json({ language, ready: r.ready, notReady: r.notReady, defaultLimit: SWEEP_DEFAULT_LIMIT, maxLimit: SWEEP_MAX_LIMIT });
};

export async function GET(request: Request) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();
  if (!libraryAllows(m.role, "generate")) return notFound();
  const language = languageOf(new URL(request.url).searchParams.get("language") ?? "ar");
  if (!language) return bad("language must be one of the lesson languages other than English.");
  const admin = createAdminClient();
  const { input, response } = await loadSweep(admin, language);
  if (!input) return response!;
  return dryRun(language, input);
}

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!libraryAllows(m.role, "generate")) return notFound();
  const language = languageOf(body.language);
  if (!language) return bad("language must be one of the lesson languages other than English.");
  const limit = limitOf(body.limit);
  if (limit === null) return bad(`limit must be a whole number from 1 to ${SWEEP_MAX_LIMIT}.`);

  const admin = createAdminClient();
  const { input, response } = await loadSweep(admin, language);
  if (!input) return response!;
  if (body.dryRun === true) return dryRun(language, input);

  // the same lock the kit route's translate action reads — AFTER the reads,
  // so a dry run still answers while generation is switched off
  if (!catalogueGenerateEnabled()) return conflict("Catalogue generation is switched off (FEATURE_CATALOGUE_GENERATE) — nothing was queued.");

  const { ready, notReady } = readyForTranslation(input, language);
  const batch = ready.slice(0, limit);
  const queued: string[] = [];
  const alreadyQueued: string[] = [];
  const skipped: { kitId: string; why: string }[] = [];
  const jobs: Record<string, string | null> = {};
  for (const c of batch) {
    const q = await enqueueTranslateJob(admin, { sourceKitId: c.kitId, topicId: c.topicId, language });
    if (!q.ok) {
      skipped.push({ kitId: c.kitId, why: q.error.message ?? "database error" });
      continue;
    }
    jobs[c.kitId] = q.jobId;
    (q.existing ? alreadyQueued : queued).push(c.kitId);
  }

  // one row per queued kit, on its topic — carrying the whole sweep
  const sweep = { language, requested: limit, ready: ready.length, queued, already_queued: alreadyQueued, skipped: skipped.map((s) => s.kitId) };
  const byKit = new Map<string, SweepCandidate>(batch.map((c) => [c.kitId, c]));
  for (const kitId of [...queued, ...alreadyQueued]) {
    const c = byKit.get(kitId)!;
    await audit(admin, m.id, "kit_translate_sweep", "topic", c.topicId, { kit_id: kitId, language, job_id: jobs[kitId], job_existing: alreadyQueued.includes(kitId), sweep });
  }

  return NextResponse.json({
    ok: true,
    language,
    queued,
    alreadyQueued,
    skipped,
    /** ready kits beyond `limit` — "then the rest" */
    remaining: Math.max(0, ready.length - batch.length),
    notReady,
  });
}
