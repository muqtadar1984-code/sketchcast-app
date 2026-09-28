import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { sortVideoArtifacts } from "@/utils/catalogue/kit";
import DemoCard, { type DemoFact, type DemoView } from "./demo-card";

// /library/demos — every generation the worker drew under a PINNED setting
// (params.demo names the experiment), newest first, with its video and the
// facts to compare against the live version. One place for every demo, and
// Delete once a demo has been judged so nothing lingers in storage. A demo
// belongs to no kit: the topic page never shows it and its lifecycle writes
// nothing onto the kit (catalogue/kit.py record_presentation).
//
// Queuing a demo is still a hand-written generations row (params.catalogue,
// topic_id, kit_id, article_id, the voices, plus params.demo and the pin,
// e.g. params.board_colour = true); the worker does the rest.

export const dynamic = "force-dynamic";

const SIGN_TTL_SECONDS = 3600;

type GenRow = {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  params: Record<string, unknown> | null;
  artifacts: { kind: string; storage_path: string }[] | null;
};

function fmtMinutes(secs: unknown): string | null {
  const n = typeof secs === "number" ? secs : Number(secs);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m} min ${s.toString().padStart(2, "0")} s`;
}

function factsOf(params: Record<string, unknown>): DemoFact[] {
  const facts: DemoFact[] = [];
  const pins = Object.entries(params).filter(([k]) => k === "board_colour" || k === "subject_profile");
  for (const [k, v] of pins) facts.push({ label: `Pinned ${k}`, value: String(v) });
  if (params.format_version !== undefined) facts.push({ label: "Format version", value: String(params.format_version) });
  const len = params.lesson_length as { audio_secs?: unknown } | undefined;
  const mins = fmtMinutes(len?.audio_secs);
  if (mins) facts.push({ label: "Audio", value: mins });
  const acc = params.acceptance_part1 as { summary?: unknown; passed?: unknown } | undefined;
  if (acc) facts.push({ label: "Acceptance", value: `${acc.passed ? "passed" : "failed"}${acc.summary ? ` · ${String(acc.summary)}` : ""}` });
  const cov = params.coverage as { covered?: unknown; addressed?: unknown; topics?: unknown }[] | undefined;
  const c = Array.isArray(cov) ? cov[0] : undefined;
  if (c && c.addressed !== undefined && c.topics !== undefined) facts.push({ label: "Coverage", value: `${String(c.addressed)} of ${String(c.topics)} topics` });
  if (typeof params.demo_of === "string") facts.push({ label: "Compare with", value: params.demo_of.slice(0, 8) });
  return facts;
}

export default async function DemosPage() {
  const member = await requireLibraryMember();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("generations")
    .select("id, kind, status, created_at, params, artifacts(kind, storage_path)")
    .not("params->>demo", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as unknown as GenRow[];

  const topicIds = [...new Set(rows.map((g) => g.params?.topic_id).filter((v): v is string => typeof v === "string"))];
  const titles = new Map<string, string>();
  if (topicIds.length) {
    const { data: topics } = await admin.from("topics").select("id, title").in("id", topicIds);
    for (const t of (topics ?? []) as { id: string; title: string }[]) titles.set(t.id, t.title);
  }

  const sign = async (path: string | null): Promise<string | null> => {
    if (!path) return null;
    const { data: signed } = await admin.storage.from("artifacts").createSignedUrl(path, SIGN_TTL_SECONDS);
    return signed?.signedUrl ?? null;
  };

  const demos: DemoView[] = await Promise.all(
    rows.map(async (g) => {
      const params = g.params ?? {};
      const videos = sortVideoArtifacts((g.artifacts ?? []).filter((a) => a.kind === "video_mp4"));
      const thumb = (g.artifacts ?? []).find((a) => a.kind === "thumbnail_png") ?? null;
      const topicId = typeof params.topic_id === "string" ? params.topic_id : null;
      return {
        id: g.id,
        demo: String(params.demo),
        topicTitle: topicId ? (titles.get(topicId) ?? null) : null,
        topicId,
        status: g.status,
        createdAt: g.created_at,
        videoUrl: await sign(videos[0]?.storage_path ?? null),
        thumbUrl: await sign(thumb?.storage_path ?? null),
        facts: factsOf(params),
      };
    }),
  );

  const canDelete = libraryAllows(member.role, "generate");

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-display mb-1">Demos</h1>
      <InkUnderline className="block h-3 w-24 mb-3" color="#7FD8A8" />
      <p className="text-[#5B6470] mb-8 max-w-3xl">
        Videos the worker drew under a pinned setting to validate a change before it goes live. None of these is a kit&apos;s video or reaches YouTube. Delete a demo once it has been
        judged; the live version is untouched either way.
      </p>
      {error && <p className="text-sm text-[#8B1E1E] mb-4">Could not load demos: {error.message}</p>}
      {demos.length === 0 ? (
        <p className="card p-5 text-[#5B6470]">No demos at the moment.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {demos.map((d) => (
            <DemoCard key={d.id} demo={d} canDelete={canDelete} />
          ))}
        </div>
      )}
    </main>
  );
}
