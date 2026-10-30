// Kit Manifest — the read path over `sk_manifests` (S1 slice A; Final Plan
// §9.6 "a stale Manifest is never served").
//
// THE RULE: readManifest returns a manifest only when the row says `ready`
// AND the manifest's pinned artifacts still match the LIVE `artifacts` rows of
// every generation it pinned (isStale(...) === false, re-checked on every
// read). The 0163 trigger flips the row to `stale` when the presentation's own
// rows change; this re-check is belt and braces over that trigger — it also
// catches the pinned worksheet's rows, which the trigger (keyed on the
// presentation's generation_id) does not see — and when it finds drift it
// flips the row itself before answering `stale`.

import type { ArtifactRow, KitManifest } from "./derive";
import { isStale, MANIFEST_DERIVATION_VERSION } from "./derive";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type StoreAdmin = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ManifestStatus = "ready" | "stale" | "building" | "failed";

export type ReadResult =
  | { status: "ready"; manifest: KitManifest; builtAt: string }
  | { status: "stale" | "building" | "failed" | "missing"; reason?: string };

export type ManifestRow = {
  generation_id: string;
  status: ManifestStatus;
  manifest: KitManifest | Record<string, never> | null;
  stale_reason: string | null;
  built_at: string;
  updated_at: string;
};

/** `{owner}/{generation}/file` → generation. Null for anything else. */
export function generationOfPath(path: string): string | null {
  const parts = path.split("/");
  return parts.length >= 3 && /^[0-9a-f-]{36}$/i.test(parts[1]) ? parts[1] : null;
}

/** Every generation whose artifacts the manifest pinned (its own, plus the
 * worksheet's): `pinned.generation_ids` when the manifest names them (built
 * from 2026-10-31), else read off the paths — right for a kit generated into
 * its own folder, WRONG for an adopted catalogue copy, whose rows sit under
 * the source generation's folder (the re-check would then hash the source's
 * rows too and call every copy's manifest stale). */
export function pinnedGenerationIds(m: KitManifest): string[] {
  const named = m.pinned?.generation_ids;
  if (Array.isArray(named) && named.length && named.every((x) => typeof x === "string" && x)) return Array.from(new Set([m.generation_id, ...named]));
  const ids = new Set<string>([m.generation_id]);
  for (const p of m.pinned?.artifact_paths ?? []) {
    const g = generationOfPath(p);
    if (g) ids.add(g);
  }
  return Array.from(ids);
}

export async function liveArtifactRows(admin: StoreAdmin, generationIds: string[]): Promise<ArtifactRow[]> {
  if (!generationIds.length) return [];
  const { data, error } = await admin.from("artifacts").select("id, generation_id, kind, storage_path, created_at").in("generation_id", generationIds);
  if (error) throw new Error(`artifacts read failed: ${(error as { message?: string }).message ?? "unknown"}`);
  return ((data ?? []) as ArtifactRow[]).map((r) => ({ id: String(r.id), generation_id: String(r.generation_id), kind: String(r.kind), storage_path: String(r.storage_path), created_at: String(r.created_at) }));
}

export async function liveFormatVersion(admin: StoreAdmin, generationId: string): Promise<number | null> {
  const { data } = await admin.from("generations").select("params").eq("id", generationId).maybeSingle();
  const fv = (data as { params?: Record<string, unknown> } | null)?.params?.format_version;
  return fv === undefined || fv === null || fv === "" ? null : Number(fv);
}

export async function readRow(admin: StoreAdmin, generationId: string): Promise<ManifestRow | null> {
  const { data, error } = await admin
    .from("sk_manifests")
    .select("generation_id, status, manifest, stale_reason, built_at, updated_at")
    .eq("generation_id", generationId)
    .maybeSingle();
  if (error) throw new Error(`sk_manifests read failed: ${(error as { message?: string }).message ?? "unknown"}`);
  return (data as ManifestRow | null) ?? null;
}

export async function markStale(admin: StoreAdmin, generationId: string, reason: string, now: Date = new Date()): Promise<void> {
  await admin
    .from("sk_manifests")
    .update({ status: "stale", stale_reason: reason.slice(0, 300), updated_at: now.toISOString() })
    .eq("generation_id", generationId)
    .eq("status", "ready");
}

/** A row that is `ready` is served only after its pins are re-verified against
 * the live rows; anything else answers with its status and never a manifest. */
export async function readManifest(admin: StoreAdmin, generationId: string, now: Date = new Date()): Promise<ReadResult> {
  const row = await readRow(admin, generationId);
  if (!row) return { status: "missing" };
  if (row.status === "building") return { status: "building" };
  if (row.status === "failed") return { status: "failed", reason: row.stale_reason ?? undefined };
  if (row.status === "stale") return { status: "stale", reason: row.stale_reason ?? undefined };
  const m = row.manifest as KitManifest | null;
  if (!m || !m.pinned || !Array.isArray(m.segments)) {
    await markStale(admin, generationId, "ready row without a manifest document", now);
    return { status: "stale", reason: "ready row without a manifest document" };
  }
  if ((m.derivation_version ?? 1) !== MANIFEST_DERIVATION_VERSION) {
    const reason = `derivation version ${m.derivation_version ?? 1} != ${MANIFEST_DERIVATION_VERSION}: rebuilt with the current loader`;
    await markStale(admin, generationId, reason, now);
    return { status: "stale", reason };
  }
  const [rows, fv] = await Promise.all([liveArtifactRows(admin, pinnedGenerationIds(m)), liveFormatVersion(admin, generationId)]);
  if (isStale(m, rows, fv)) {
    const reason = "read-time re-check: artifacts or format_version changed since derivation";
    await markStale(admin, generationId, reason, now);
    return { status: "stale", reason };
  }
  return { status: "ready", manifest: m, builtAt: row.built_at };
}
