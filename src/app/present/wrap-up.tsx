"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_BODY } from "@/utils/present/audience";

// The thirty seconds after the bell.
//
// THE DRAFT ARRIVES ALREADY WRITTEN. That is the whole design constraint: she
// has one class leaving and another arriving, and a blank box with a "Draft"
// button in it would be a blank box for ever. The note is requested the moment
// this panel mounts, and if the model is unavailable or rate-limited she gets an
// honest sentence built from the grounding instead of an error — something to
// edit rather than something to retry.
//
// PUBLISHING IS A SEPARATE TAP FROM SAVING, and it is reversible. She can
// rewrite the sentence as often as she likes without it reaching anybody; and a
// published note can be withdrawn, because a revoke with no restore is how a
// typo becomes permanent — the notice board had to grow /api/notices/unrevoke
// for exactly this reason.
//
// NOT TRANSLATED, like the rest of Present mode: one allowlisted account. The
// student-facing page has the same gap and it matters more there — see
// docs/PRESENT-MODE.md, "Going public".

type Props = {
  sessionId: string;
  /** Where the exported roll ended up, or why it did not. */
  roll: { ok: true; pages: number } | { ok: false; why: string } | null;
  onDone: () => void;
};

type Draft = {
  draft: string;
  body: string;
  source: "model" | "fallback";
  note: string | null;
};

export default function WrapUp({ sessionId, roll, onDone }: Props) {
  const [body, setBody] = useState<string | null>(null);
  const [meta, setMeta] = useState<Draft | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("Writing the note…");
  const [error, setError] = useState<string | null>(null);
  /** What she has typed, so a late draft cannot overwrite it. */
  const edited = useRef(false);

  // GUARDED BY THE EFFECT'S OWN `live` FLAG AND NOTHING ELSE.
  //
  // The obvious guard — a one-shot ref — deadlocks under Strict Mode, which is
  // on by default in the App Router: mount 1 sets the ref and starts the fetch,
  // the cleanup sets live=false, mount 2 sees the ref and returns without
  // starting anything, and the only in-flight request then resolves against a
  // dead flag. Every setState is skipped and the panel sits on "Writing the
  // note…" for ever, with nothing on screen to explain it. In dev that is every
  // lesson.
  //
  // What the ref was actually protecting — not clobbering something she has
  // already typed — is a check on the ASSIGNMENT instead, which is both correct
  // and cheaper.
  useEffect(() => {
    let live = true;
    fetch("/api/present/recap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as Draft & { error?: string };
        if (!r.ok) throw new Error(d.error || `Could not draft (${r.status})`);
        return d;
      })
      .then((d) => {
        if (!live) return;
        setMeta(d);
        if (!edited.current) setBody(d.body || d.draft);
        setBusy(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        // A failed draft must not cost her the note. An empty box she can type
        // into is a working feature; an error with no box is not.
        if (!edited.current) setBody("");
        setBusy(null);
        setError(e instanceof Error ? e.message : "Could not draft the note.");
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const send = useCallback(
    async (publish: boolean | undefined, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const r = await fetch("/api/present/recap", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, body: body ?? "", ...(publish === undefined ? {} : { publish }) }),
        });
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          publishedAt?: string | null;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
        setPublishedAt(d.publishedAt ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save the note.");
      } finally {
        setBusy(null);
      }
    },
    [sessionId, body],
  );

  const link =
    typeof window !== "undefined" && publishedAt
      ? `${window.location.origin}/present/recap/${sessionId}`
      : null;

  const chars = (body ?? "").trim().length;
  const over = chars > MAX_BODY;
  const btn = "rounded-lg border border-[#2A363B] bg-[#141B1F] px-4 py-2.5 text-sm text-[#C2CCC7]";

  return (
    <section className="mx-auto grid w-full max-w-2xl gap-4 p-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6F69]">
          Lesson saved
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What did the class do?</h1>
        <p className="mt-2 text-sm text-[#93A09A]">
          One or two sentences, about the idea rather than the lesson plan. Students who missed
          the period and their parents read this.
        </p>
      </header>

      <label className="grid gap-1">
        <span className="sr-only">Lesson note</span>
        <textarea
          value={body ?? ""}
          disabled={body === null}
          onChange={(e) => {
            edited.current = true;
            setBody(e.target.value);
          }}
          rows={4}
          className="w-full rounded-xl border border-[#2A363B] bg-[#141B1F] px-4 py-3 text-base leading-relaxed text-[#E7EDE9] disabled:opacity-50"
          placeholder={body === null ? "Writing the note…" : "Explored how a plant cell differs from an animal cell."}
        />
        <span className={`text-end font-mono text-[10px] ${over ? "text-[#E58A93]" : "text-[#5F6F69]"}`}>
          {chars} / {MAX_BODY}
        </span>
      </label>

      {/* Where the sentence came from. She should never have to guess whether
          she is editing a model's words or her own. */}
      {meta?.source === "fallback" && (
        <p className="rounded-lg border border-[#4A3A1C] bg-[#2C2318] px-3 py-2 font-mono text-[11px] leading-snug text-[#E0A664]">
          Drafted from the chapter rather than by the model{meta.note ? ` — ${meta.note}` : ""}. Worth
          a read before publishing.
        </p>
      )}
      {error && <p className="text-sm text-[#E58A93]">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={!!busy || body === null} onClick={() => send(undefined, "Saving…")}>
          Save
        </button>
        {publishedAt ? (
          <button type="button" className={btn} disabled={!!busy} onClick={() => send(false, "Withdrawing…")}>
            Withdraw
          </button>
        ) : (
          <button
            type="button"
            disabled={!!busy || over || !chars}
            onClick={() => send(true, "Publishing…")}
            className="rounded-lg bg-[#0C8175] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Publish to the class
          </button>
        )}
        <button type="button" className={`${btn} ms-auto`} onClick={onDone}>
          Done
        </button>
      </div>

      {busy && <p className="font-mono text-[11px] text-[#4FD6C2]">{busy}</p>}

      {link && (
        <p className="rounded-xl border border-[#17544C] bg-[#12302C] px-4 py-3 text-sm text-[#4FD6C2]">
          Published. Anyone in the class can open it here:
          <span className="mt-1 block break-all font-mono text-[11px] opacity-80">{link}</span>
        </p>
      )}

      {/* The roll's own fate, reported rather than assumed. A note that promises
          a board nobody can open is worse than one that admits the upload
          failed. */}
      <p className="font-mono text-[11px] leading-snug text-[#5F6F69]">
        {roll === null
          ? "Saving the board…"
          : roll.ok
            ? `Board saved — ${roll.pages} ${roll.pages === 1 ? "page" : "pages"}, attached to this note.`
            : `The board could not be saved (${roll.why}). The note will publish without it.`}
      </p>
    </section>
  );
}
