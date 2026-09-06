"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TEACHER_AVATARS, canTransition, reopenTarget } from "@/utils/catalogue/status";
import type { Coverage, Curriculum, NodeHit, Topic, TopicAlias, TopicHit } from "@/utils/catalogue/types";
import { CoverageChip, StatusChip } from "../../catalogue-ui";
import { NodeSearch, TopicSearch } from "../../pickers";

// The topic page's interactive panels. Every control POSTs
// /api/library/topics/[id] with {action, …} and then router.refresh() so the
// Server Component re-reads the row (ops-controls.tsx pattern). `can*` flags
// come from the server (libraryAllows on the member's role); the route
// re-checks them, these only decide what renders.

type Post = (payload: Record<string, unknown>, label: string) => Promise<Record<string, unknown> | null>;

function useTopicPost(topicId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const post: Post = async (payload, label) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/library/topics/${topicId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(null);
    if (!res.ok) {
      setError((json.error as string) ?? "Something went wrong.");
      return null;
    }
    if (json.unchanged) setNotice("Nothing changed.");
    router.refresh();
    return json;
  };
  return { post, busy, error, notice };
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#9A6400]">{notice}</p>}
    </>
  );
}

// ── Header: title / subject / summary / avatar ───────────────────────────────

export function TopicHeaderEditor({ topic, canCurate }: { topic: Topic; canCurate: boolean }) {
  const { post, busy, error, notice } = useTopicPost(topic.id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(topic.title);
  const [subject, setSubject] = useState(topic.subject ?? "");
  const [summary, setSummary] = useState(topic.summary ?? "");
  const [avatar, setAvatar] = useState(topic.teacher_avatar ?? "");
  const avatarOptions = [...TEACHER_AVATARS] as string[];
  if (topic.teacher_avatar && !avatarOptions.includes(topic.teacher_avatar)) avatarOptions.push(topic.teacher_avatar);

  if (!editing) {
    return (
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#5B6470]">
              {topic.subject ?? "No subject"} · key <span className="font-mono text-xs">{topic.canonical_key}</span>
            </p>
            <p className="mt-2 text-sm whitespace-pre-wrap">{topic.summary || <span className="text-[#98A0A9]">No summary yet.</span>}</p>
            <p className="mt-2 text-xs text-[#5B6470]">
              Teacher avatar:{" "}
              <span className="font-mono">{topic.teacher_avatar || "cast from the voice (default)"}</span>
            </p>
          </div>
          {canCurate && (
            <button type="button" onClick={() => setEditing(true)} className="btn-ghost h-9 px-3 text-sm shrink-0">
              Edit
            </button>
          )}
        </div>
        <Messages error={error} notice={notice} />
      </div>
    );
  }

  return (
    <form
      className="card p-5 space-y-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await post({ action: "update", title, subject, summary, teacher_avatar: avatar }, "update");
        if (r) setEditing(false);
      }}
    >
      <label className="block">
        <span className="text-xs text-[#5B6470]">Title (display; the canonical key does not change)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} className="field w-full h-9 px-3 mt-1" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-[#5B6470]">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={60} className="field w-full h-9 px-3 mt-1" />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Teacher avatar (roster id; blank = cast from the voice)</span>
          <select value={avatar} onChange={(e) => setAvatar(e.target.value)} className="field w-full h-9 px-2 mt-1">
            <option value="">default (from the voice)</option>
            {avatarOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Summary</span>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} rows={4} className="field w-full px-3 py-2 mt-1" />
      </label>
      <Messages error={error} notice={notice} />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!!busy} className="btn-primary h-9 px-4">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="btn-ghost h-9 px-3">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Actions: approve / retire / reopen / merge ──────────────────────────────

export function TopicActions({ topic, canCurate, canApprove }: { topic: Topic; canCurate: boolean; canApprove: boolean }) {
  const { post, busy, error, notice } = useTopicPost(topic.id);
  const router = useRouter();
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState<TopicHit | null>(null);
  const reopenTo = reopenTarget(topic.status);
  const showApprove = canApprove && canTransition(topic.status, "approved");
  const showRetire = canCurate && canTransition(topic.status, "retired");
  const showReopen = canCurate && reopenTo !== null;
  const showMerge = canCurate && topic.status !== "retired";

  if (!showApprove && !showRetire && !showReopen && !showMerge) return null;

  return (
    <div className="card p-5 space-y-3">
      <h2 className="font-medium">Actions</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {showApprove && (
          <button type="button" disabled={!!busy} onClick={() => post({ action: "approve" }, "approve")} className="btn-primary h-9 px-4">
            {busy === "approve" ? "…" : "Approve"}
          </button>
        )}
        {showReopen && (
          <button type="button" disabled={!!busy} onClick={() => post({ action: "reopen" }, "reopen")} className="btn-ghost h-9 px-3">
            {busy === "reopen" ? "…" : `Reopen → ${reopenTo!.replace(/_/g, " ")}`}
          </button>
        )}
        {showMerge && (
          <button type="button" disabled={!!busy} onClick={() => setMerging((v) => !v)} className="btn-ghost h-9 px-3">
            Merge into…
          </button>
        )}
        {showRetire && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm("Retire this topic? Its aliases and mappings stay; it leaves every queue.")) {
                void post({ action: "retire" }, "retire");
              }
            }}
            className="h-9 px-3 rounded-lg text-sm bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2]"
          >
            {busy === "retire" ? "…" : "Retire"}
          </button>
        )}
      </div>
      {merging && (
        <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2 text-sm">
          <p className="text-xs text-[#5B6470]">
            Everything attached to this topic — aliases, curriculum mappings, open candidates and prerequisite references —
            moves to the target; this title becomes one of its aliases, and this topic retires.
          </p>
          {target ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                Into <span className="font-medium">{target.title}</span> <StatusChip status={target.status} />
              </span>
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  const r = await post({ action: "merge", targetId: target.id }, "merge");
                  if (r) router.push(`/library/topics/${target.id}`);
                }}
                className="btn-primary h-9 px-4"
              >
                {busy === "merge" ? "Merging…" : "Confirm merge"}
              </button>
              <button type="button" onClick={() => setTarget(null)} className="btn-ghost h-9 px-3">
                Pick another
              </button>
            </div>
          ) : (
            <TopicSearch onPick={setTarget} exclude={[topic.id]} placeholder="Search the target topic…" autoFocus />
          )}
        </div>
      )}
      <Messages error={error} notice={notice} />
    </div>
  );
}

// ── Aliases ─────────────────────────────────────────────────────────────────

export function AliasPanel({ topicId, aliases, canCurate }: { topicId: string; aliases: TopicAlias[]; canCurate: boolean }) {
  const { post, busy, error, notice } = useTopicPost(topicId);
  const [alias, setAlias] = useState("");
  return (
    <div className="card p-5 space-y-3">
      <h2 className="font-medium">
        Aliases <span className="text-sm text-[#5B6470] font-normal">({aliases.length})</span>
      </h2>
      <p className="text-xs text-[#5B6470]">
        Every name a book or syllabus uses for this topic. The harvester matches candidates against these, by key.
      </p>
      {aliases.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">No aliases.</p>
      ) : (
        <ul className="divide-y divide-[#EEF0EC] text-sm">
          {aliases.map((a) => (
            <li key={a.id} className="py-2 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                {a.alias} <span className="text-xs text-[#98A0A9] font-mono">{a.normalized}</span>{" "}
                <span className="chip bg-[#EEF0EC] text-[#5B6470]">{a.source}</span>
              </span>
              {canCurate && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => post({ action: "alias_remove", aliasId: a.id }, `alias-${a.id}`)}
                  className="text-xs text-[#B3401F] hover:underline shrink-0"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canCurate && (
        <form
          className="flex items-center gap-2 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post({ action: "alias_add", alias }, "alias-add");
            if (r) setAlias("");
          }}
        >
          <input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={120} placeholder="Add an alias…" className="field h-9 px-3 flex-1" />
          <button type="submit" disabled={!!busy || !alias.trim()} className="btn-primary h-9 px-4">
            Add
          </button>
        </form>
      )}
      <Messages error={error} notice={notice} />
    </div>
  );
}

// ── Curriculum mappings + depth node ─────────────────────────────────────────

export type MappingRow = {
  id: string;
  node_id: string;
  coverage: Coverage;
  notes: string | null;
  node: { id: string; code: string; grade: string | null; strand: string | null; sub_strand: string | null; title: string; curriculum_id: string } | null;
  curriculum: { id: string; code: string; name: string } | null;
};

export function MappingPanel({
  topic,
  mappings,
  curricula,
  canCurate,
}: {
  topic: Topic;
  mappings: MappingRow[];
  curricula: Curriculum[];
  canCurate: boolean;
}) {
  const { post, busy, error, notice } = useTopicPost(topic.id);
  const [curriculumId, setCurriculumId] = useState(curricula[0]?.id ?? "");
  const [node, setNode] = useState<NodeHit | null>(null);
  const [coverage, setCoverage] = useState<Coverage>("full");
  const [notes, setNotes] = useState("");
  const mappedNodeIds = mappings.map((m) => m.node_id);

  return (
    <div className="card p-5 space-y-3">
      <h2 className="font-medium">
        Curriculum mappings <span className="text-sm text-[#5B6470] font-normal">({mappings.length})</span>
      </h2>
      {mappings.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">Not mapped to any curriculum node yet.</p>
      ) : (
        <ul className="divide-y divide-[#EEF0EC] text-sm">
          {mappings.map((m) => (
            <li key={m.id} className="py-2 flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="font-mono text-xs text-[#1F5B99]">{m.node?.code ?? m.node_id}</span>{" "}
                <span className="font-medium">{m.node?.title ?? "(node missing)"}</span>
                <span className="block text-xs text-[#5B6470]">
                  {[m.curriculum?.name, m.node?.grade && `Grade ${m.node.grade}`, m.node?.strand, m.node?.sub_strand].filter(Boolean).join(" · ")}
                </span>
                {m.notes && <span className="block text-xs text-[#5B6470] italic">{m.notes}</span>}
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <CoverageChip coverage={m.coverage} />
                {topic.depth_node_id === m.node_id && <span className="chip bg-[#EDE7FB] text-[#5B3FBF]">depth</span>}
                {canCurate && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => post({ action: "mapping_remove", mappingId: m.id }, `map-${m.id}`)}
                    className="text-xs text-[#B3401F] hover:underline"
                  >
                    Remove
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canCurate && (
        <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2 text-sm">
          <p className="text-xs text-[#5B6470]">Add a mapping</p>
          {curricula.length === 0 ? (
            <p className="text-[#98A0A9]">No curricula loaded yet — the seed for Cambridge and CBSE fills the picker.</p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <select
                  value={curriculumId}
                  onChange={(e) => {
                    setCurriculumId(e.target.value);
                    setNode(null);
                  }}
                  className="field h-9 px-2"
                  aria-label="Curriculum"
                >
                  {curricula.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {node ? (
                  <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-[#F4F6F3] min-w-0">
                    <span className="font-mono text-xs text-[#1F5B99]">{node.code}</span>
                    <span className="truncate">{node.title}</span>
                    <button type="button" onClick={() => setNode(null)} className="ml-auto text-xs text-[#5B6470] hover:underline">
                      change
                    </button>
                  </div>
                ) : (
                  <NodeSearch key={curriculumId} curriculumId={curriculumId} onPick={setNode} exclude={mappedNodeIds} />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={coverage} onChange={(e) => setCoverage(e.target.value as Coverage)} className="field h-9 px-2" aria-label="Coverage">
                  <option value="full">full coverage</option>
                  <option value="partial">partial coverage</option>
                </select>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Notes (optional)" className="field h-9 px-3 flex-1 min-w-40" />
                <button
                  type="button"
                  disabled={!!busy || !node}
                  onClick={async () => {
                    if (!node) return;
                    const r = await post({ action: "mapping_add", nodeId: node.id, coverage, notes }, "map-add");
                    if (r) {
                      setNode(null);
                      setNotes("");
                    }
                  }}
                  className="btn-primary h-9 px-4"
                >
                  Add mapping
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {mappings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm pt-1">
          <label className="text-xs text-[#5B6470]" htmlFor={canCurate ? "depth-node" : undefined}>
            Depth node (the curriculum node that sets how deep the article goes):
          </label>
          {canCurate ? (
            <select
              id="depth-node"
              value={topic.depth_node_id ?? ""}
              disabled={!!busy}
              onChange={(e) => post({ action: "set_depth", nodeId: e.target.value || null }, "depth")}
              className="field h-9 px-2 disabled:opacity-60"
            >
              <option value="">— not set —</option>
              {mappings.map((m) => (
                <option key={m.node_id} value={m.node_id}>
                  {m.node?.code ?? m.node_id} · {m.node?.title ?? ""}
                </option>
              ))}
            </select>
          ) : (
            // A reviewer reads the depth; a greyed-out control would only say
            // "you may not" — the chip says what it is.
            (() => {
              const depth = mappings.find((m) => m.node_id === topic.depth_node_id);
              return depth ? (
                <span className="chip bg-[#EDE7FB] text-[#5B3FBF]">
                  <span className="font-mono">{depth.node?.code ?? depth.node_id}</span>
                  {depth.node?.title && ` · ${depth.node.title}`}
                </span>
              ) : (
                <span className="chip bg-[#EEF0EC] text-[#5B6470]">not set</span>
              );
            })()
          )}
        </div>
      )}
      <Messages error={error} notice={notice} />
    </div>
  );
}

// ── Prerequisites ───────────────────────────────────────────────────────────

export function PrereqPanel({
  topicId,
  prerequisites,
  dependants,
  canCurate,
}: {
  topicId: string;
  prerequisites: TopicHit[];
  dependants: TopicHit[];
  canCurate: boolean;
}) {
  const { post, busy, error, notice } = useTopicPost(topicId);
  return (
    <div className="card p-5 space-y-3">
      <h2 className="font-medium">
        Prerequisites <span className="text-sm text-[#5B6470] font-normal">({prerequisites.length})</span>
      </h2>
      {prerequisites.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">No prerequisites.</p>
      ) : (
        <ul className="divide-y divide-[#EEF0EC] text-sm">
          {prerequisites.map((p) => (
            <li key={p.id} className="py-2 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <Link href={`/library/topics/${p.id}`} className="font-medium hover:underline">
                  {p.title}
                </Link>{" "}
                <StatusChip status={p.status} />
              </span>
              {canCurate && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => post({ action: "prereq_remove", topicId: p.id }, `pre-${p.id}`)}
                  className="text-xs text-[#B3401F] hover:underline shrink-0"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canCurate && (
        <TopicSearch
          onPick={(t) => void post({ action: "prereq_add", topicId: t.id }, "pre-add")}
          exclude={[topicId, ...prerequisites.map((p) => p.id)]}
          placeholder="Add a prerequisite topic…"
        />
      )}
      {dependants.length > 0 && (
        <p className="text-xs text-[#5B6470]">
          Required by:{" "}
          {dependants.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <Link href={`/library/topics/${d.id}`} className="hover:underline">
                {d.title}
              </Link>
            </span>
          ))}
        </p>
      )}
      <Messages error={error} notice={notice} />
    </div>
  );
}
