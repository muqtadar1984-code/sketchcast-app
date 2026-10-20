"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { controlsFor, type AgentControl, type AgentMode } from "@/utils/catalogue/auto-translate";
import { Drawer } from "../topics/[id]/review-inbox";

// The Auto Translate Agent's buttons and the per-language "Approve all clean"
// drawer on the Translations tab (Auto Translate Agent plan §5.2, §6.1). The
// routes decide everything: /api/library/translations/agent writes the
// founder's controls, /api/library/translations/approve-clean says which
// in-review kits are clean and approves them.

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const LABEL: Record<AgentControl, string> = {
  on: "Turn on",
  off: "Turn off",
  pause: "Pause",
  resume: "Resume",
  go_live: "Go live",
  dry_run: "Back to dry run",
};

const CONFIRM: Partial<Record<AgentControl, string>> = {
  go_live:
    "Go live: the agent will QUEUE real translations, one at a time, continuously, until the backlog is done (about $1 each). Continue?",
  on: "Turn the agent on? It starts in whatever mode is set (dry run unless you went live).",
};

export function AgentControls({ mode, enabled, dryRun, paused }: { mode: AgentMode; enabled: boolean; dryRun: boolean; paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<AgentControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const press = async (action: AgentControl) => {
    const ask = CONFIRM[action];
    if (ask && !window.confirm(ask)) return;
    setBusy(action);
    setError(null);
    const res = await fetch("/api/library/translations/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const json = await readJson(res);
    setBusy(null);
    if (!res.ok) setError((json.error as string) ?? "The setting was not saved.");
    else router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {controlsFor(mode, enabled, dryRun, paused).map((a) => (
        <button
          key={a}
          type="button"
          disabled={busy !== null}
          onClick={() => press(a)}
          className={a === "go_live" ? "btn-primary h-8 px-3 text-sm" : "btn-ghost h-8 px-3 text-sm"}
        >
          {busy === a ? "…" : LABEL[a]}
        </button>
      ))}
      {error && <span className="text-xs text-[#B3401F]">{error}</span>}
    </div>
  );
}

type Listed = { kitId: string; topicId: string; title: string };
type DryRun = { clean: Listed[]; notClean: (Listed & { why: string })[]; maxPerClick: number };
type Answer = { approved: Listed[]; failed: (Listed & { why: string })[]; left: number };

export function ApproveCleanButton({ language, name, inReview }: { language: string; name: string; inReview: number }) {
  return (
    <Drawer label={<span className="text-xs">Approve all clean</span>} title={`Approve all clean — ${name}`} wide={false}>
      <ApproveCleanPanel language={language} name={name} inReview={inReview} />
    </Drawer>
  );
}

function ApproveCleanPanel({ language, name, inReview }: { language: string; name: string; inReview: number }) {
  const router = useRouter();
  const [dry, setDry] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/library/translations/approve-clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, dryRun: true }),
    }).then(async (res) => {
      const json = await readJson(res);
      if (!live) return;
      if (!res.ok) setError((json.error as string) ?? "Could not read the kits in review.");
      else setDry(json as unknown as DryRun);
    });
    return () => {
      live = false;
    };
  }, [language]);

  const approve = async () => {
    if (!dry) return;
    const n = Math.min(dry.clean.length, dry.maxPerClick);
    if (!window.confirm(`Approve ${n} clean ${name} kit${n === 1 ? "" : "s"}? They go live in the app for teachers and parents now.`)) return;
    setBusy(true);
    const res = await fetch("/api/library/translations/approve-clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, kitIds: dry.clean.map((c) => c.kitId) }),
    });
    const json = await readJson(res);
    setBusy(false);
    if (!res.ok) {
      setError((json.error as string) ?? "The approvals failed.");
      return;
    }
    setAnswer(json as unknown as Answer);
    router.refresh();
  };

  if (error) return <p className="text-sm text-[#B3401F]">{error}</p>;
  if (!dry) return <p className="text-sm text-[#5B6470]">Checking the {inReview} kits in review…</p>;
  if (answer) {
    return (
      <div className="text-sm space-y-2">
        <p className="text-[#0F7A68] font-medium">Approved {answer.approved.length}.</p>
        {answer.failed.length > 0 && (
          <ul className="text-[#B3401F] list-disc pl-5">
            {answer.failed.map((f) => (
              <li key={f.kitId}>
                {f.title}: {f.why}
              </li>
            ))}
          </ul>
        )}
        {answer.left > 0 && <p className="text-[#5B6470]">{answer.left} more clean — open this again to approve the next batch.</p>}
      </div>
    );
  }
  return (
    <div className="text-sm space-y-4">
      <p className="text-[#5B6470]">
        Clean means: the pre-checks passed with no blocking finding and every piece of the English kit is here and done.
        Approving puts a kit live in the app at once. Flags that do not block (a redrawn picture, a dropped duplicate item)
        do not stop it — spot-check a few first.
      </p>
      <section>
        <h3 className="font-medium mb-1">Will be approved ({Math.min(dry.clean.length, dry.maxPerClick)}{dry.clean.length > dry.maxPerClick ? ` of ${dry.clean.length}` : ""})</h3>
        {dry.clean.length ? (
          <ul className="list-disc pl-5">
            {dry.clean.slice(0, dry.maxPerClick).map((c) => (
              <li key={c.kitId}>
                <a className="underline" href={`/library/topics/${c.topicId}`} target="_blank" rel="noreferrer">
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[#8A929C]">None is clean.</p>
        )}
      </section>
      {dry.notClean.length > 0 && (
        <section>
          <h3 className="font-medium mb-1">Left in review for a look ({dry.notClean.length})</h3>
          <ul className="list-disc pl-5 text-[#5B6470]">
            {dry.notClean.map((c) => (
              <li key={c.kitId}>
                {c.title} — {c.why}
              </li>
            ))}
          </ul>
        </section>
      )}
      <button type="button" className="btn-primary h-9 px-4" disabled={busy || dry.clean.length === 0} onClick={approve}>
        {busy ? "Approving…" : `Approve ${Math.min(dry.clean.length, dry.maxPerClick)}`}
      </button>
    </div>
  );
}
