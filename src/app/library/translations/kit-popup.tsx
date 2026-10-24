"use client";

import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import { SideDrawer } from "@/components/side-drawer";

// The Translations matrix's popup (founder 2026-10-24): an Approved or Posted
// cell opens the translated kit in a sheet — its approval, the video, the
// pieces, where it stands on YouTube — and, at the end, the option to post it.
// Posting goes through the YouTube Publishing Agent's route
// (/api/library/youtube/agent, "add"): the route re-applies selectableForPost
// and queues the kit; the worker uploads it, one video per language per day.
// Nothing here posts by itself.

type KitDetail = {
  ok: true;
  kit: {
    id: string;
    language: string;
    status: string;
    translationStatus: string;
    sourceKitId: string | null;
    createdAt: string;
    reviewedAt: string | null;
    reviewer: string | null;
    notes: string | null;
    judgeScore: number | null;
    model: string | null;
    translationCostUsd: number | null;
  };
  topic: { id: string; title: string; subject: string | null } | null;
  video: { part: number; url: string | null }[];
  pieces: { kind: string; label: string; url: string | null }[];
  youtube: {
    state: string;
    stateLabel: string;
    category: "posted" | "not_posted";
    channel: { language: string; exists: boolean; lastPoll: string | null };
    parts: { part: number; videoId: string | null; privacy: string | null; thumbnailSet: boolean | null; error: string | null }[];
    liveJob: { id: string; status: string } | null;
    postable: { ok: boolean; why?: string };
    inboxHref: string;
  } | null;
  youtubeError: string | null;
  queued: { id: string; status: string } | null;
  canPost: boolean;
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

/** An Approved / Posted cell of the matrix: looks like the other cells, opens the sheet. */
export function KitCell({
  kitId,
  className,
  title,
  languageName,
  topicTitle,
  inboxHref,
  children,
}: {
  kitId: string;
  className: string;
  title: string;
  languageName: string;
  topicTitle: string;
  inboxHref: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<KitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/library/translations/kit?kitId=${encodeURIComponent(kitId)}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as KitDetail | { error?: string };
      if (!res.ok || !("ok" in json)) setError(("error" in json && json.error) || `Could not load the kit (${res.status}).`);
      else setData(json);
    } catch {
      setError("Could not load the kit — check the connection and try again.");
    }
  }, [kitId]);

  const show = () => {
    setOpen(true);
    if (!data) void load();
  };
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button type="button" onClick={show} title={title} className={`w-full ${className}`}>
        {children}
      </button>
      <SideDrawer open={open} onClose={close} wide={false} title={`${topicTitle} · ${languageName}`}>
        {error && <p className="text-sm text-[#B3401F] mb-3">{error}</p>}
        {!data && !error && <p className="text-sm text-[#5B6470]">Loading…</p>}
        {data && <KitBody d={data} languageName={languageName} inboxHref={inboxHref} onChanged={load} />}
      </SideDrawer>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase tracking-wide text-[#8A929C] mb-2">{title}</h3>
      {children}
    </section>
  );
}

function KitBody({ d, languageName, inboxHref, onChanged }: { d: KitDetail; languageName: string; inboxHref: string; onChanged: () => Promise<void> }) {
  const yt = d.youtube;
  return (
    <div className="text-sm">
      <Section title="Translation">
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
          <dt className="text-[#5B6470]">Topic</dt>
          <dd>
            {d.topic?.title ?? "—"} <span className="text-[#8A929C]">{d.topic?.subject ?? ""}</span>
          </dd>
          <dt className="text-[#5B6470]">Language</dt>
          <dd>
            {languageName} <span className="text-[#8A929C]">{d.kit.language}</span>
          </dd>
          <dt className="text-[#5B6470]">Status</dt>
          <dd className="capitalize">{d.kit.status.replace(/_/g, " ")}</dd>
          <dt className="text-[#5B6470]">Approved</dt>
          <dd>
            {day(d.kit.reviewedAt)}
            {d.kit.reviewer ? ` by ${d.kit.reviewer}` : ""}
          </dd>
          <dt className="text-[#5B6470]">Translated</dt>
          <dd>
            {day(d.kit.createdAt)}
            {d.kit.model ? ` · ${d.kit.model}` : ""}
            {d.kit.translationCostUsd != null ? ` · $${d.kit.translationCostUsd.toFixed(2)}` : ""}
          </dd>
          {d.kit.notes && (
            <>
              <dt className="text-[#5B6470]">Notes</dt>
              <dd className="whitespace-pre-wrap">{d.kit.notes}</dd>
            </>
          )}
        </dl>
        <Link href={inboxHref} className="inline-block mt-2 text-xs underline text-[#5B6470] hover:text-[#14181F]">
          Open in the review inbox
        </Link>
      </Section>

      <Section title="Video">
        {d.video.length === 0 && <p className="text-[#5B6470]">No rendered video.</p>}
        {d.video.map((v) =>
          v.url ? (
            <div key={v.part} className="mb-3">
              {d.video.length > 1 && <p className="text-xs text-[#5B6470] mb-1">Part {v.part}</p>}
              <video controls preload="metadata" src={v.url} className="w-full rounded border border-[#EEF0EC] bg-black" />
            </div>
          ) : (
            <p key={v.part} className="text-[#B3401F]">Part {v.part}: the file could not be signed.</p>
          ),
        )}
      </Section>

      <Section title="Pieces">
        {d.pieces.length === 0 ? (
          <p className="text-[#5B6470]">No pieces recorded.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {d.pieces.map((p) => (
              <li key={p.kind}>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer" className="btn-ghost h-8 px-3 text-xs inline-flex items-center">
                    {p.label}
                  </a>
                ) : (
                  <span className="h-8 px-3 text-xs inline-flex items-center text-[#8A929C]">{p.label} (no file)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="YouTube">
        {!yt && <p className="text-[#5B6470]">{d.youtubeError ? `Could not read the YouTube status: ${d.youtubeError}` : "Not in the YouTube list."}</p>}
        {yt && (
          <>
            <p className="mb-2">
              <span className="font-medium">{yt.stateLabel}</span>
              <span className="text-[#5B6470]">
                {" "}
                · {languageName} channel {yt.channel.exists ? "" : "(not set up yet)"}
              </span>
            </p>
            {yt.parts.filter((p) => p.videoId).length > 0 && (
              <ul className="mb-2 space-y-1">
                {yt.parts
                  .filter((p) => p.videoId)
                  .map((p) => (
                    <li key={p.part}>
                      <a href={`https://www.youtube.com/watch?v=${p.videoId}`} target="_blank" rel="noreferrer" className="underline">
                        {yt.parts.length > 1 ? `Part ${p.part}` : "Watch on YouTube"}
                      </a>
                      <span className="text-[#5B6470]">
                        {" "}
                        · {p.privacy ?? "privacy unknown"}
                        {p.thumbnailSet === false ? " · no thumbnail" : ""}
                      </span>
                      {p.error && <span className="block text-xs text-[#B3401F]">{p.error}</span>}
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
        <PostBlock d={d} languageName={languageName} onChanged={onChanged} />
      </Section>
    </div>
  );
}

/** The end of the sheet: post to YouTube — or why not, or where it already is. */
function PostBlock({ d, languageName, onChanged }: { d: KitDetail; languageName: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const yt = d.youtube;

  if (d.queued) {
    return (
      <p className="rounded bg-[#E6F6F2] text-[#0F7A68] px-3 py-2">
        In the posting queue ({d.queued.status}). The YouTube Publishing Agent posts one video per language per day, privately.{" "}
        <Link href="/library/translations/youtube" className="underline">
          See the queue
        </Link>
      </p>
    );
  }
  if (!yt || yt.category === "posted") return null;
  if (!d.canPost) return <p className="text-[#5B6470]">Only an admin can post to YouTube.</p>;
  if (!yt.postable.ok) return <p className="rounded bg-[#FFF1D6] text-[#9A6400] px-3 py-2">Cannot post yet: {yt.postable.why}</p>;

  const add = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/library/youtube/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", kitIds: [d.kit.id] }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; plan?: { accepted?: unknown[]; excluded?: { why: string }[] } };
      // a 409 carries the plan: its excluded row says why (already queued, …)
      if (!res.ok) setNote({ ok: false, text: json.plan?.excluded?.[0]?.why ?? json.error ?? `Could not queue it (${res.status}).` });
      else if (json.plan?.accepted?.length) {
        setNote({ ok: true, text: "Added to the posting queue." });
        await onChanged();
      } else setNote({ ok: false, text: json.plan?.excluded?.[0]?.why ?? "It was not added." });
    } catch {
      setNote({ ok: false, text: "Could not queue it — check the connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-[#E3E6E0] bg-white p-3">
      <p className="mb-2">
        Ready to post. The YouTube Publishing Agent uploads it to the <span className="font-medium">{languageName}</span> channel as a private video, one
        video per language per day; use <span className="font-medium">Run once more</span> on the YouTube videos page to post sooner.
      </p>
      <button type="button" onClick={add} disabled={busy} className="btn-primary h-9 px-4 disabled:opacity-60">
        {busy ? "Adding…" : "Post to YouTube"}
      </button>
      {note && <p className={`mt-2 text-xs ${note.ok ? "text-[#0F7A68]" : "text-[#B3401F]"}`}>{note.text}</p>}
    </div>
  );
}
