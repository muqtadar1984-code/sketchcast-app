"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import AssignModal, { type ChildRow, type ClassRow } from "../assign-modal";
import { type LibraryMessages } from "../labels";

export type KitsMessages = Dictionary["kits"];

/** One download link on a card: already an href into /api/catalogue/file. */
export type DownloadLink = { label: string; href: string };
/** A piece as the card shows it: its library label, its downloads, and the
 * generation the Add-to-Library copy is made from. */
export type PieceView = { kind: string; generationId: string; label: string; downloads: DownloadLink[] };

const BTN_PRIMARY =
  "inline-flex items-center rounded-lg bg-[#0C8175] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#0A6F65] disabled:opacity-60";
const BTN_GHOST =
  "inline-flex items-center rounded-lg border border-[#CBD3D1] px-3.5 py-2 text-sm font-medium text-[#1F2A37] hover:bg-[#F3F6F5] disabled:opacity-60";

// The card's one interactive strip. Three states, decided by the SERVER
// (unlocked or not) and then by the database on every click:
//   · locked    → Unlock. unlock_catalogue_kit() answers with a status word,
//                 and this component only translates it; the weekly cap, the
//                 release gate and the role rule all live in that function.
//   · unlocked  → the downloads (plain links; /api/catalogue/file re-checks
//                 access on every click and mints a short URL) and
//                 "Add to my Library".
//   · adopted   → Assign (the Library's own modal, over the COPIES — the rows
//                 the teacher owns, which is what generation_shares' RLS wants)
//                 and a link to the Library.
// Add-to-Library adopts every piece, one RPC each. adopt_catalogue_piece is
// idempotent per (owner, source), so a retry after a half-finished run picks
// up where it stopped rather than duplicating anything.
export default function KitActions({
  topicId,
  unlocked,
  canUnlock,
  resetsLabel,
  pieces,
  assignableIds,
  classes,
  childTargets,
  t,
  tLib,
}: {
  topicId: string;
  unlocked: boolean;
  canUnlock: boolean;
  resetsLabel: string;
  pieces: PieceView[];
  /** The pieces a student may receive (no lesson plan), as SOURCE ids. */
  assignableIds: string[];
  classes: ClassRow[];
  childTargets: ChildRow[] | null;
  t: KitsMessages;
  tLib: LibraryMessages;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** source generation id → the viewer's copy id, once adopted. */
  const [copies, setCopies] = useState<Record<string, string> | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: rpcError } = await supabase.rpc("unlock_catalogue_kit", { p_topic: topicId });
    setBusy(false);
    const status = (data as { status?: string } | null)?.status;
    if (rpcError || !status) {
      setError(t.failed);
      return;
    }
    if (status === "unlocked" || status === "already") {
      router.refresh();
      return;
    }
    if (status === "weekly_limit") setError(fmt(t.weeklyLimit, { date: resetsLabel }));
    else if (status === "not_available") setError(t.notAvailable);
    else if (status === "forbidden_role") setError(t.ineligibleRole);
    else if (status === "suspended") setError(t.ineligibleSuspended);
    else setError(t.ineligibleOther);
  };

  const addToLibrary = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const made: Record<string, string> = {};
    for (const p of pieces) {
      const { data, error: rpcError } = await supabase.rpc("adopt_catalogue_piece", { p_source: p.generationId });
      if (rpcError || typeof data !== "string") {
        setBusy(false);
        setError(t.failed);
        // Keep what did land: the next click resumes (idempotent RPC).
        if (Object.keys(made).length) setCopies(made);
        return;
      }
      made[p.generationId] = data;
    }
    setBusy(false);
    setCopies(made);
    // The Library now holds the copies; refresh so a return there shows them.
    router.refresh();
  };

  if (!unlocked) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={unlock} disabled={busy || !canUnlock} className={BTN_PRIMARY}>
          {busy ? t.unlocking : t.unlock}
        </button>
        {!canUnlock && !error && <span className="text-xs text-[#5B6470]">{fmt(t.weeklyLimit, { date: resetsLabel })}</span>}
        {error && (
          <span role="alert" className="text-xs text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    );
  }

  const copyIds = copies ? assignableIds.map((id) => copies[id]).filter((id): id is string => !!id) : [];
  const adopted = !!copies && copyIds.length === assignableIds.length;

  return (
    <div className="mt-4 space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
        {pieces.map((p) => (
          <li key={p.generationId} className="flex items-center gap-2">
            <span className="text-[#1F2A37]">{p.label}</span>
            {p.downloads.map((d) => (
              <a key={d.href} href={d.href} className="font-medium text-[#0C8175] hover:underline">
                ⬇ {d.label}
              </a>
            ))}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        {!adopted && (
          <button type="button" onClick={addToLibrary} disabled={busy} className={BTN_PRIMARY}>
            {busy ? t.adding : t.addToLibrary}
          </button>
        )}
        {adopted && (
          <>
            <span className="text-sm font-medium text-[#0C8175]">✓ {t.added}</span>
            <AssignModal label={t.assign} generationIds={copyIds} classes={classes} childTargets={childTargets} t={tLib} />
            <a href="/dashboard" className={BTN_GHOST}>
              {t.openLibrary}
            </a>
          </>
        )}
        {error && (
          <span role="alert" className="text-xs text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
