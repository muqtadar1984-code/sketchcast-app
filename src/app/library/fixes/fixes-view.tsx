import Link from "next/link";
import { InkUnderline } from "@/components/ink-mark";
import AutoRefresh from "@/components/auto-refresh";
import { languageLabel } from "@/utils/narration";
import {
  actionLabel,
  actionsOf,
  checkRuleOf,
  classificationLabel,
  findingsOf,
  highlightSegments,
  historyOf,
  isDecidable,
  isOpen,
  outcomeInReview,
  statusLabel,
  usd,
  verdictsOf,
  waiversOf,
  type Diagnosis,
  type Evidence,
  type FixCase,
  type HistoryRound,
  type Outcome,
  type Proposal,
} from "@/utils/fixes/fix-cases";
import { AgentSwitch, DecisionButtons } from "./fix-actions";

// Library → Fixes' screen: the agent's switch, then one card per case. A
// Server Component with no reads of its own — page.tsx authenticates and
// loads. Every JSON field is the worker's and read through the defensive
// helpers in utils/fixes/fix-cases.ts.

const STATUS_TONE: Record<string, string> = {
  new: "bg-[#EDE7FB] text-[#5B3FBF]",
  diagnosing: "bg-[#EDE7FB] text-[#5B3FBF]",
  proposed: "bg-[#FFF1D6] text-[#9A6400]",
  approved: "bg-[#E3EEFB] text-[#1F5FA8]",
  applied: "bg-[#E3EEFB] text-[#1F5FA8]",
  resolved: "bg-[#E6F6F2] text-[#0F7A68]",
  rejected: "bg-[#F4F5F2] text-[#5B6470]",
  needs_founder: "bg-[#FFE9E3] text-[#B3401F]",
};

const LIVE = new Set(["new", "diagnosing", "approved", "applied"]);

function when(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : null);

export function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Fixes</h1>
      <InkUnderline className="block h-3 w-24 mb-3" color="#7FD8A8" />
    </div>
  );
}

export function AgentHeader({ enabled, available }: { enabled: boolean; available: boolean }) {
  return (
    <section className="card p-4 mb-5 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[16rem]">
        <p className="text-sm">
          <span className="font-medium">Fix Agent</span>{" "}
          <span className={`chip ${enabled ? "bg-[#E6F6F2] text-[#0F7A68]" : "bg-[#F4F5F2] text-[#5B6470]"}`}>{enabled ? "On" : "Off"}</span>
        </p>
        <p className="text-xs text-[#5B6470] mt-1 max-w-3xl">
          When a translation fails, the agent reads the failure, compares the English with the translation, and proposes a fix.
          Nothing is retried until you approve it; an approved fix waits for the translation lane, then the retried kit lands in review.
        </p>
      </div>
      {available && <AgentSwitch enabled={enabled} />}
    </section>
  );
}

function Highlighted({ text, tokens }: { text: string | undefined; tokens: string[] }) {
  if (!text) return <span className="text-[#8A929C]">—</span>;
  return (
    <>
      {highlightSegments(text, tokens).map((s, i) =>
        s.hit ? (
          <mark key={i} className="bg-[#FFE9A8] text-inherit rounded px-0.5">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function EvidenceTable({ evidence, rtl }: { evidence: Evidence | null | undefined; rtl: boolean }) {
  const findings = findingsOf(evidence);
  const meta: string[] = [];
  if (typeof evidence?.part === "number") meta.push(`Part ${evidence.part}`);
  if (evidence?.reproduced === true) meta.push("reproduced");
  if (evidence?.reproduced === false) meta.push("not reproduced");
  if (!findings.length) return meta.length ? <p className="text-xs text-[#5B6470]">{meta.join(" · ")}</p> : null;
  return (
    <div>
      <h3 className="text-sm font-medium mb-1">
        Evidence {meta.length > 0 && <span className="text-[#5B6470] font-normal">— {meta.join(" · ")}</span>}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-[#F4F5F2] text-[#5B6470]">
            <tr>
              <th className="text-left font-normal px-2 py-1">Field</th>
              <th className="text-left font-normal px-2 py-1">English</th>
              <th className="text-left font-normal px-2 py-1">Translation</th>
              <th className="text-left font-normal px-2 py-1">Numbers added / dropped</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => {
              const tokens = [...f.extra, ...f.missing];
              return (
                <tr key={i} className="border-t border-[#EEF0EC] align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{f.where ?? "—"}</div>
                    {f.what && <div className="text-xs text-[#5B6470]">{f.what}</div>}
                  </td>
                  <td className="px-2 py-1.5 max-w-md">
                    <Highlighted text={f.source} tokens={tokens} />
                  </td>
                  <td className="px-2 py-1.5 max-w-md" dir={rtl ? "rtl" : undefined}>
                    <Highlighted text={f.target} tokens={tokens} />
                  </td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                    {f.extra.length > 0 && <div className="text-[#B3401F]">added: {f.extra.join(", ")}</div>}
                    {f.missing.length > 0 && <div className="text-[#9A6400]">dropped: {f.missing.join(", ")}</div>}
                    {!f.extra.length && !f.missing.length && <span className="text-[#8A929C]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiagnosisBlock({ diagnosis }: { diagnosis: Diagnosis | null | undefined }) {
  const verdicts = verdictsOf(diagnosis);
  if (!diagnosis?.classification && !diagnosis?.explanation && !verdicts.length) return null;
  return (
    <div>
      <h3 className="text-sm font-medium mb-1">
        Diagnosis: <span className="font-normal">{classificationLabel(diagnosis?.classification)}</span>
      </h3>
      {diagnosis?.explanation && <p className="text-sm text-[#14181F] whitespace-pre-line">{diagnosis.explanation}</p>}
      {verdicts.length > 0 && (
        <ul className="text-sm mt-1 space-y-0.5">
          {verdicts.map((v, i) => (
            <li key={i}>
              <span className="font-medium">{v.where ?? "—"}</span>:{" "}
              <span className={v.verdict === "wrong" ? "text-[#B3401F]" : v.verdict === "faithful" ? "text-[#0F7A68]" : ""}>{v.verdict ?? "—"}</span>
              {v.why && <span className="text-[#5B6470]"> — {v.why}</span>}
            </li>
          ))}
        </ul>
      )}
      {typeof diagnosis?.model === "string" && diagnosis.model && <p className="text-xs text-[#8A929C] mt-1">Model: {diagnosis.model}</p>}
    </div>
  );
}

function ProposalBlock({ proposal, risk }: { proposal: Proposal | null | undefined; risk?: string | null }) {
  const actions = actionsOf(proposal);
  const waivers = waiversOf(proposal);
  const rule = checkRuleOf(proposal);
  const cost = usd(proposal?.est_cost_usd);
  const level = proposal?.risk ?? risk;
  if (!proposal?.summary && !actions.length && !waivers.length && !rule) return null;
  return (
    <div>
      <h3 className="text-sm font-medium mb-1">
        Proposal {level === "sensitive" && <span className="chip bg-[#FFE9E3] text-[#B3401F] ml-1">sensitive</span>}
      </h3>
      {proposal?.summary && <p className="text-sm whitespace-pre-line">{proposal.summary}</p>}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {actions.map((a) => (
            <span key={a} className="chip bg-[#EEF0EC] text-[#14241E]">
              {actionLabel(a)}
            </span>
          ))}
        </div>
      )}
      {typeof proposal?.note === "string" && proposal.note.trim() && (
        <blockquote className="mt-2 border-l-4 border-[#7FD8A8] bg-[#F4F5F2] px-3 py-2 text-sm whitespace-pre-line">
          <span className="block text-xs text-[#5B6470] mb-0.5">Instruction for the translator</span>
          {proposal.note}
        </blockquote>
      )}
      {waivers.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-[#5B6470]">Waivers (the check lets these through on the retry):</p>
          <ul className="text-sm list-disc pl-5">
            {waivers.map((w, i) => (
              <li key={i}>
                <span className="font-medium">{w.where ?? "—"}</span>
                {w.what && <span className="text-[#5B6470]"> ({w.what})</span>}
                {w.extra.length > 0 && <span> · added {w.extra.join(", ")}</span>}
                {w.missing.length > 0 && <span> · dropped {w.missing.join(", ")}</span>}
                {w.justification && <span className="text-[#5B6470]"> — {w.justification}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rule && (
        <div className="mt-2 rounded-lg bg-[#FFF9EE] px-3 py-2 text-sm">
          <p className="text-xs text-[#9A6400] font-medium">Check-rule change — needs a PR (Phase 2); not applied by approving</p>
          {rule.file && <p className="text-xs text-[#5B6470] font-mono">{rule.file}</p>}
          <p className="whitespace-pre-line">{rule.change}</p>
          {rule.test && <p className="text-xs text-[#5B6470] mt-1">Test: {rule.test}</p>}
        </div>
      )}
      {(proposal?.blast_radius || cost) && (
        <p className="text-xs text-[#5B6470] mt-2">
          {proposal?.blast_radius && <>Blast radius: {proposal.blast_radius}</>}
          {proposal?.blast_radius && cost && " · "}
          {cost && <>Estimated cost: {cost}</>}
        </p>
      )}
    </div>
  );
}

function OutcomeLine({ outcome, appliedJobId, status, topicId }: { outcome: Outcome | null | undefined; appliedJobId?: string | null; status: string; topicId?: string | null }) {
  const o = outcome ?? {};
  const jobId = appliedJobId ?? o.job_id;
  if (!jobId && !o.kit_status && !o.translation_status && !o.error) return null;
  const parts: string[] = [];
  if (jobId) parts.push(`job ${shortId(jobId)}${o.job_status ? ` (${o.job_status})` : ""}`);
  if (o.kit_id) parts.push(`kit ${shortId(o.kit_id)}`);
  if (o.kit_status) parts.push(`kit ${o.kit_status}`);
  if (o.translation_status) parts.push(`translation ${o.translation_status}`);
  return (
    <div className="text-sm">
      <span className="font-medium">Retry:</span> {parts.join(" · ")}
      {o.at && <span className="text-[#8A929C]"> · {when(o.at)}</span>}
      {o.error && <div className="text-[#B3401F] text-xs mt-0.5">{o.error}</div>}
      {topicId && outcomeInReview(o, status) && (
        <div>
          <Link href={`/library/topics/${topicId}`} className="text-xs underline text-[#1F5FA8]">
            Open the kit in review →
          </Link>
        </div>
      )}
    </div>
  );
}

function Decided({ by, at, note, people }: { by?: string | null; at?: string | null; note?: string | null; people: Record<string, string> }) {
  if (!by && !at) return null;
  return (
    <p className="text-sm">
      <span className="font-medium">Decision:</span> {by ? (people[by] ?? shortId(by)) : "—"}
      {at && <span className="text-[#8A929C]"> · {when(at)}</span>}
      {note && <span className="text-[#5B6470]"> — “{note}”</span>}
    </p>
  );
}

function HistoryRounds({ history, people, topicId, rtl }: { history: HistoryRound[]; people: Record<string, string>; topicId?: string | null; rtl: boolean }) {
  if (!history.length) return null;
  return (
    <details className="mt-1">
      <summary className="text-xs text-[#5B6470] cursor-pointer">Earlier rounds ({history.length})</summary>
      <div className="mt-2 space-y-4 border-l-2 border-[#EEF0EC] pl-4">
        {history.map((h, i) => (
          <div key={i} className="space-y-3">
            <p className="text-xs font-medium text-[#5B6470]">Round {h.round ?? i + 1}</p>
            <DiagnosisBlock diagnosis={h.diagnosis} />
            <EvidenceTable evidence={h.evidence} rtl={rtl} />
            <ProposalBlock proposal={h.proposal} />
            <Decided by={h.decided_by} at={h.decided_at} people={people} />
            <OutcomeLine outcome={h.outcome} appliedJobId={h.applied_job_id} status="" topicId={topicId} />
          </div>
        ))}
      </div>
    </details>
  );
}

const RTL = new Set(["ar", "ur", "ms-arab"]);

function CaseCard({ c, topics, people, canDecide }: { c: FixCase; topics: Record<string, string>; people: Record<string, string>; canDecide: boolean }) {
  const status = String(c.status ?? "");
  const rtl = RTL.has(c.language ?? "");
  const topicTitle = c.topic_id ? topics[c.topic_id] : undefined;
  const cost = usd(c.cost_usd);
  return (
    <article className={`card p-5 space-y-4 ${isOpen(c) ? "" : "opacity-80"}`}>
      <header className="flex flex-wrap items-start gap-2">
        <h2 className="text-lg font-medium flex-1 min-w-[14rem]">{c.title || "Untitled case"}</h2>
        {c.language && (
          <span className="chip bg-[#E3EEFB] text-[#1F5FA8]" title={languageLabel(c.language) ?? c.language}>
            {c.language}
          </span>
        )}
        <span className={`chip ${STATUS_TONE[status] ?? "bg-[#F4F5F2] text-[#5B6470]"}`}>{statusLabel(status)}</span>
        {typeof c.round === "number" && <span className="chip bg-[#F4F5F2] text-[#5B6470]">Round {c.round} of 2</span>}
      </header>

      {c.issue && <p className="text-sm text-[#B3401F] font-mono break-words">{c.issue}</p>}

      <p className="text-xs text-[#5B6470]">
        {c.topic_id ? (
          <Link href={`/library/topics/${c.topic_id}`} className="underline">
            {topicTitle ?? `topic ${shortId(c.topic_id)}`}
          </Link>
        ) : (
          "No topic"
        )}
        {c.source_kit_id && <> · English kit {shortId(c.source_kit_id)}</>}
        {c.source_job_id && <> · failed job {shortId(c.source_job_id)}</>}
        {c.created_at && <> · opened {when(c.created_at)}</>}
        {c.resolved_at && <> · closed {when(c.resolved_at)}</>}
      </p>

      <DiagnosisBlock diagnosis={c.diagnosis} />
      <EvidenceTable evidence={c.evidence} rtl={rtl} />
      <ProposalBlock proposal={c.proposal} risk={c.risk} />

      <Decided by={c.decided_by} at={c.decided_at} note={c.decision_note} people={people} />
      <OutcomeLine outcome={c.outcome} appliedJobId={c.applied_job_id} status={status} topicId={c.topic_id} />
      {cost && <p className="text-xs text-[#5B6470]">Measured cost so far: {cost}</p>}

      {canDecide && isDecidable(c) && <DecisionButtons id={c.id} />}

      <HistoryRounds history={historyOf(c.history)} people={people} topicId={c.topic_id} rtl={rtl} />
    </article>
  );
}

export function FixesView({
  cases,
  topics,
  people,
  enabled,
  canDecide,
}: {
  cases: FixCase[];
  topics: Record<string, string>;
  people: Record<string, string>;
  enabled: boolean;
  canDecide: boolean;
}) {
  const live = cases.some((c) => LIVE.has(String(c.status)));
  const open = cases.filter(isOpen);
  const closed = cases.filter((c) => !isOpen(c));
  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <AutoRefresh active={live} seconds={30} />
      <Heading />
      <AgentHeader enabled={enabled} available={canDecide} />
      {cases.length === 0 ? (
        <p className="card p-8 text-center text-[#5B6470]">No failures to fix.</p>
      ) : (
        <div className="space-y-4">
          {open.map((c) => (
            <CaseCard key={c.id} c={c} topics={topics} people={people} canDecide={canDecide} />
          ))}
          {closed.length > 0 && (
            <h2 className="text-sm font-medium text-[#5B6470] pt-4">Closed in the last 30 days ({closed.length})</h2>
          )}
          {closed.map((c) => (
            <CaseCard key={c.id} c={c} topics={topics} people={people} canDecide={canDecide} />
          ))}
        </div>
      )}
    </main>
  );
}
