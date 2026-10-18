import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readChunks } from "@/app/api/library/lib";
import { kitGenerationIds } from "./kit";
import { typicalTranslation, type LaneState, type TranslationClockData, type TranslationSample, type TranslationTiming } from "./translation-eta";

// The reads behind the translation clock (translation-eta.ts): how long the
// recent translations took, and what the worker's translation lane holds
// now. Read-only, three small reads plus one chunked job read; a failed read
// degrades to the default typical run and an empty lane — a clock is never
// worth an error banner.
//
// A sample is one translation kit that reached review (in review, approved
// or rejected): from its kit row (written when the translate job runs) to
// the newest `done` job among its generations — the last piece finished.

/** The newest translation kits measured. */
const SAMPLE_KITS = 40;

type SampleKit = {
  id: string;
  topic_id: string;
  created_at: string;
  presentation_generation_id: string | null;
  doc_generation_ids: Record<string, string> | null;
};

export async function loadTranslationTiming(admin: SupabaseClient): Promise<TranslationClockData> {
  const [timing, lane] = await Promise.all([measure(admin), readLane(admin)]);
  return { timing, lane, nowMs: Date.now() };
}

async function measure(admin: SupabaseClient): Promise<TranslationTiming> {
  const fallback = typicalTranslation([]);
  const { data, error } = await admin
    .from("topic_kits")
    .select("id, topic_id, created_at, presentation_generation_id, doc_generation_ids")
    .not("source_kit_id", "is", null)
    .neq("language", "en")
    .in("status", ["in_review", "approved", "rejected"])
    .order("created_at", { ascending: false })
    .limit(SAMPLE_KITS);
  if (error || !data?.length) return fallback;
  const kits = data as SampleKit[];

  const genToKit = new Map<string, string>();
  for (const k of kits) for (const g of kitGenerationIds({ ...k, doc_generation_ids: k.doc_generation_ids ?? {} })) genToKit.set(g, k.id);
  const jobs = await readChunks<{ generation_id: string; updated_at: string }>([...genToKit.keys()], (chunk) =>
    admin.from("jobs").select("generation_id, updated_at").in("generation_id", chunk).eq("status", "done"),
  );
  if (jobs.error) return fallback;
  const lastDone = new Map<string, number>();
  for (const j of jobs.rows) {
    const kit = genToKit.get(j.generation_id);
    const t = Date.parse(j.updated_at);
    if (kit && Number.isFinite(t) && t > (lastDone.get(kit) ?? 0)) lastDone.set(kit, t);
  }

  const topicIds = [...new Set(kits.map((k) => k.topic_id))];
  const topics = await readChunks<{ id: string; subject: string | null }>(topicIds, (chunk) => admin.from("topics").select("id, subject").in("id", chunk));
  const subjectOf = new Map(topics.rows.map((t) => [t.id, t.subject]));

  const samples: TranslationSample[] = [];
  for (const k of kits) {
    const end = lastDone.get(k.id);
    const start = Date.parse(k.created_at);
    if (end && Number.isFinite(start)) samples.push({ subject: subjectOf.get(k.topic_id) ?? null, minutes: (end - start) / 60000 });
  }
  return typicalTranslation(samples);
}

async function readLane(admin: SupabaseClient): Promise<LaneState> {
  const [jobsQ, kitsQ] = await Promise.all([
    admin.from("jobs").select("id, status, created_at, claimed_at").eq("type", "kit_translate").in("status", ["queued", "processing"]).order("created_at", { ascending: true }),
    admin.from("topic_kits").select("created_at").eq("status", "generating").neq("language", "en").not("source_kit_id", "is", null).order("created_at", { ascending: true }).limit(1),
  ]);
  const jobs = (jobsQ.error ? [] : (jobsQ.data ?? [])) as { id: string; status: string; created_at: string; claimed_at: string | null }[];
  const running = jobs.find((j) => j.status === "processing");
  const building = kitsQ.error ? null : ((kitsQ.data ?? [])[0] as { created_at: string } | undefined);
  return {
    runningSince: running ? (running.claimed_at ?? running.created_at) : (building?.created_at ?? null),
    queued: jobs.filter((j) => j.status === "queued").map((j) => ({ id: j.id, created_at: j.created_at })),
  };
}
