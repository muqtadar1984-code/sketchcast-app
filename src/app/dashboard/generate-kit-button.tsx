"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows } from "./kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { kitSignature } from "@/utils/kit-match";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";
import { type LibraryMessages } from "./labels";

// One-click full kit for a chapter part (0059): queues the video lesson plus
// its five documents together — one lesson credit, documents free. Used on
// per-part rows; the chapter-level row has its own kit flow with narration
// options (chapter-generate.tsx).
export default function GenerateKitButton({
  bookId,
  schoolId,
  chapterNum,
  part = null,
  language = null,
  skipKinds = [],
  bookGrade = null,
  t,
  className = "",
  children,
  gate = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  part?: number | null;
  language?: string | null;
  /** Doc kinds that already exist for this unit (legacy standalone docs) —
      the kit skips them instead of inserting duplicates. */
  skipKinds?: string[];
  /** Book grade — age-appropriate narration default (grades 1–4 → Storytelling). */
  bookGrade?: string | null;
  t: LibraryMessages;
  /** Render the trigger yourself — the whole un-generated lesson card becomes the
      button, so the click target is the card, not a small link at its edge.
      Receives `busy` so the caller can show its own "Queuing…" state. */
  className?: string;
  children?: (state: { busy: boolean }) => React.ReactNode;
  /** Junk-upload gate: non-null for a gated book — the INSERT path confirms
      first (and stamps every row); adopting a colleague's finished kit burns
      nothing, so that path is deliberately NOT gated. */
  gate?: JunkGateInfo | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A finished kit for exactly this part that someone else in the school
  // already made. Generation is the expensive step — six artifacts, ~56 worker
  // minutes — so the question is worth asking before queuing another one.
  const [offer, setOffer] = useState<{ ids: string[] } | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);

  const chapterRef = String(chapterNum);

  /** What this click WOULD produce, as signatures — so the school's kits can be
   *  compared against it rather than against "same chapter, near enough". */
  function wantedSignatures(): Set<string> {
    const rows = kitRows({
      bookId,
      schoolId,
      userId: "-",
      chapterNum,
      part,
      language,
      narrationStyle: defaultNarrationForGrade(bookGrade),
    });
    return new Set(
      rows.map((r) => kitSignature({ kind: r.kind, chapterRef: r.chapter_ref, params: r.params, grade: bookGrade })),
    );
  }

  /** Best-effort: any failure here just means we generate, as before. */
  async function findSchoolKit(): Promise<{ ids: string[] } | null> {
    if (!schoolId) return null;
    try {
      const supabase = createClient();
      const { data } = await supabase.rpc("school_kits_for", { p_book: bookId, p_chapter: chapterRef });
      const rows = (data ?? []) as { id: string; kind: string; params: Record<string, unknown> | null }[];
      if (!rows.length) return null;
      const wanted = wantedSignatures();
      const usable = rows.filter((r) =>
        wanted.has(kitSignature({ kind: r.kind, chapterRef, params: r.params, grade: bookGrade })),
      );
      // Only offer when the LESSON itself is there. A stray worksheet is not a
      // kit, and swapping one document for a colleague's would be a surprise
      // rather than a saving.
      if (!usable.some((r) => r.kind === "presentation")) return null;
      return { ids: usable.map((r) => r.id) };
    } catch {
      return null;
    }
  }

  async function useSchoolKit() {
    if (!offer || adopting) return;
    setAdopting(true);
    const supabase = createClient();
    // Each row is adopted on its own: the RPC is idempotent per (book, part,
    // kind, params), so a partial failure can simply be retried.
    for (const id of offer.ids) {
      const { error: aErr } = await supabase.rpc("adopt_school_kit", { p_source: id });
      if (aErr) {
        setError(aErr.message);
        setAdopting(false);
        return;
      }
    }
    setAdopting(false);
    setOffer(null);
    router.refresh();
  }

  async function generate() {
    setBusy(true);
    setError(null);

    // Ask once. "Make my own" clears the offer and the next click falls
    // straight through — the choice is always the teacher's.
    if (!offer) {
      const hit = await findSchoolKit();
      if (hit) {
        setOffer(hit);
        setBusy(false);
        return;
      }
    }

    // Junk-upload gate: this is the path that INSERTS (and bills) — confirm
    // first. Adoption above reuses a colleague's kit and burns nothing, so it
    // never asks.
    if (gate) {
      setGateOpen(true);
      setBusy(false);
      return;
    }
    await insert(false);
  }

  async function insert(confirmed: boolean) {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }
    const rows = kitRows({
      bookId,
      schoolId,
      userId: user.id,
      chapterNum,
      part,
      language,
      narrationStyle: defaultNarrationForGrade(bookGrade),
    })
      .filter((r) => r.kind === "presentation" || !skipKinds.includes(r.kind))
      // The record that the teacher was warned — on EVERY row this click queues.
      .map((r) => (confirmed ? { ...r, params: stampConfirmation(r.params) } : r));
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setGateOpen(false); // close either way — an error must not hide behind the overlay
    if (gErr) {
      setBusy(false); // only the failure path frees the button
      setError(gErr.message);
      return;
    }
    // DO NOT clear busy here. The insert is fast — the real work happens later in
    // the worker — but nothing on screen changes until router.refresh() lands. It
    // used to re-enable in that gap, so the teacher saw a live button on an
    // apparently untouched page, clicked again, and got a SECOND full kit. That
    // happened twice in production (3.8 s and 18 s apart), and since 0075 a kit is
    // 6 credits against a Teacher Pro allowance of 24.
    //
    // Staying disabled until the refresh replaces this control is the fix. The
    // timeout is only so a refresh that never lands cannot strand the button
    // forever — by then the row exists and the server-side guard (0076) covers
    // the click anyway.
    router.refresh();
    setTimeout(() => setBusy(false), 15000);
  }

  // Rendered OUTSIDE the trigger: the card variant makes the caller's whole
  // card a <button>, and a dialog nested inside one is invalid and unusable.
  // The junk-upload gate's confirm rides the same slot for the same reason.
  const gateDialog = gateOpen && gate && (
    <JunkGateDialog
      gate={gate}
      busy={busy}
      onConfirm={() => void insert(true)}
      onCancel={() => setGateOpen(false)}
    />
  );
  const dialog = offer && (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#14181F]/30" onClick={() => !adopting && setOffer(null)} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t.reuse.title} className="relative card w-full max-w-md p-6 space-y-3">
        <h2 className="text-xl">{t.reuse.title}</h2>
        <p className="text-sm text-[#5B6470]">{t.reuse.body}</p>
        <p className="text-xs text-[#98A0A9]">{t.reuse.hint}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            onClick={() => {
              setOffer(null);
              void generate();
            }}
            disabled={adopting}
            className="btn-ghost h-9 px-3 text-sm"
          >
            {t.reuse.makeMyOwn}
          </button>
          <button onClick={useSchoolKit} disabled={adopting} className="btn-primary h-9 px-3 text-sm">
            {adopting ? t.reuse.adding : t.reuse.useIt}
          </button>
        </div>
      </div>
    </div>
  );

  // Card variant: the caller's whole card IS the button.
  if (children) {
    return (
      <>
        <button
          onClick={generate}
          disabled={busy}
          className={className}
          title="Generates the video lesson plus its plan, activities, worksheet, test paper and case study — one lesson credit, documents free"
        >
          {children({ busy })}
          {error && (
            <span className="ms-2 text-[10px] text-red-600 [overflow-wrap:anywhere]">{error}</span>
          )}
        </button>
        {dialog}
        {gateDialog}
      </>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[10px] text-red-600 [overflow-wrap:anywhere]">{error}</span>}
      <button
        onClick={generate}
        disabled={busy}
        className="font-medium text-[#0C8175] hover:underline disabled:opacity-60 text-xs"
        title="Generates the video lesson plus its plan, activities, worksheet, test paper and case study — one lesson credit, documents free"
      >
        {busy ? "Queuing…" : "Generate kit"}
      </button>
      {dialog}
      {gateDialog}
    </span>
  );
}
