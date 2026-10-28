import { listCostLines, listStages } from "@/utils/books/store";
import { listBookRuns } from "@/utils/books/runs";
import { loadBook } from "../load";
import { Card, usd } from "../../ui";

// /books/[slug]/costs — model spend recorded in the book's own ledgers (each
// chapter's drafting ledger, the audits' and the corrections' costs), by
// stage, model and chapter. Image renders were NOT recorded in the ledgers of
// this book's first draft (≈ $8–12 by estimate), so they are not in the total.
function Table({ rows, total }: { rows: [string, number, number][]; total: number }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([k, v, n]) => (
          <tr key={k} className="border-t border-[#EFE8D8] first:border-t-0">
            <td className="py-1.5 pe-3">{k}</td>
            <td className="py-1.5 pe-3 text-end text-xs text-[#7A7363] tabular-nums">{n} calls</td>
            <td className="py-1.5 w-40">
              <div className="h-1.5 rounded bg-[#EFE8D8]">
                <div className="h-1.5 rounded bg-[#B8862F]" style={{ width: `${total ? Math.max(2, (v / total) * 100) : 0}%` }} />
              </div>
            </td>
            <td className="py-1.5 ps-3 text-end tabular-nums font-medium">{usd(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function CostsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work } = await loadBook(slug);
  const [lines, stages, runs] = await Promise.all([listCostLines(work.uid), listStages(work.uid), listBookRuns(work.uid, 200)]);
  const runLabel = new Map(runs.map((r) => [r.id, `#${r.id} · ${r.label}`]));
  const runLines = lines.filter((l) => l.run_id);
  const runTotal = runLines.reduce((s, l) => s + Number(l.usd || 0), 0);
  const title = new Map(stages.map((s) => [s.key, s.title]));
  const total = lines.reduce((s, l) => s + Number(l.usd || 0), 0);
  const by = (key: (l: (typeof lines)[number]) => string): [string, number, number][] => {
    const m = new Map<string, [number, number]>();
    for (const l of lines) {
      const k = key(l);
      const [v, n] = m.get(k) ?? [0, 0];
      m.set(k, [v + Number(l.usd || 0), n + 1]);
    }
    return [...m.entries()].map(([k, [v, n]]) => [k, v, n] as [string, number, number]).sort((a, b) => b[1] - a[1]);
  };
  return (
    <div className="space-y-4">
      <Card title="Recorded model spend">
        <p className="font-display text-3xl">{usd(total)}</p>
        <p className="text-sm text-[#7A7363] mt-1">{lines.length} recorded calls. Image renders for the first draft were not recorded in the ledgers (≈ $8–12 estimated) and are not included.</p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By stage">
          <Table rows={by((l) => title.get(l.stage_key) ?? l.stage_key)} total={total} />
        </Card>
        <Card title="By model">
          <Table rows={by((l) => l.model ?? "model not recorded (corrections)")} total={total} />
        </Card>
        {runLines.length > 0 && (
          <Card title={`Runs from the app · ${usd(runTotal)}`}>
            <Table
              rows={(() => {
                const m = new Map<string, [number, number]>();
                for (const l of runLines) {
                  const k = runLabel.get(l.run_id!) ?? `#${l.run_id}`;
                  const [v, n] = m.get(k) ?? [0, 0];
                  m.set(k, [v + Number(l.usd || 0), n + 1]);
                }
                return [...m.entries()].map(([k, [v, n]]) => [k, v, n] as [string, number, number]);
              })()}
              total={runTotal}
            />
          </Card>
        )}
        <Card title="By chapter">
          <Table rows={by((l) => (l.chapter ? `Chapter ${l.chapter}` : "Book-level")).sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))} total={total} />
        </Card>
      </div>
    </div>
  );
}
