import Link from "next/link";
import { listArtifacts, listStages } from "@/utils/books/store";
import type { Artifact } from "@/utils/books/types";
import { loadRecords } from "../load";
import { bytes, Card, Chip, Empty } from "../../ui";

// /books/[slug]/files[?stage=] — every stored file of the book, by the stage
// that made it. Opening or downloading mints a short-lived link per click.
// A large PDF opens as its screen copy; "download full file" fetches the original.
const KIND_LABEL: Record<string, string> = {
  book_pdf: "book PDF",
  qa_report: "report",
  gate_d_packet: "Gate D packet",
  kdp: "KDP",
  record: "record",
  image: "image",
  page: "page",
  note: "note",
  sql: "SQL",
  log: "log",
};

export default async function FilesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { work } = await loadRecords(slug);
  const [artifacts, stages] = await Promise.all([listArtifacts(work.uid), listStages(work.uid)]);
  const only = typeof sp.stage === "string" ? sp.stage : null;
  const kind = typeof sp.kind === "string" ? sp.kind : null;
  const order = [...stages.map((s) => s.key), "publisher_pack", "other"];
  const title = new Map<string, string>([...stages.map((s) => [s.key, s.title] as [string, string]), ["publisher_pack", "Publisher send-out pack (parked)"], ["other", "Other records"]]);
  const groups = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    if (kind && a.kind !== kind) continue;
    const k = a.stage_key ?? "other";
    if (only && k !== only) continue;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const fileHref = (a: Artifact, download = false) => `/api/pub/file?book=${encodeURIComponent(slug)}&id=${a.id}${download ? "&download=1" : ""}`;
  const kinds = [...new Set(artifacts.map((a) => a.kind))].sort();
  const q = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    if (only) p.set("stage", only);
    if (kind) p.set("kind", kind);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    return `/books/${slug}/files${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Link href={q({ kind: null })} className={`rounded-full border px-2.5 py-0.5 ${!kind ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white"}`}>
          all types
        </Link>
        {kinds.map((k) => (
          <Link key={k} href={q({ kind: k })} className={`rounded-full border px-2.5 py-0.5 ${kind === k ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white"}`}>
            {KIND_LABEL[k] ?? k}
          </Link>
        ))}
        {only && (
          <Link href={q({ stage: null })} className="ms-2 underline text-[#7A7363]">
            show every stage
          </Link>
        )}
      </div>
      {groups.size === 0 && <Empty>No files.</Empty>}
      {order
        .filter((k) => groups.has(k))
        .map((k) => (
          <Card key={k} title={title.get(k) ?? k} aside={<span className="text-xs text-[#7A7363]">{groups.get(k)!.length} files</span>}>
            <ul className="divide-y divide-[#EFE8D8]">
              {groups.get(k)!.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 break-all">
                    <a href={fileHref(a)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {a.rel_path}
                    </a>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-[#7A7363]">
                    <Chip label={KIND_LABEL[a.kind] ?? a.kind} tone="parked" />
                    {a.screen_key ? (
                      <span className="tabular-nums text-end" title="Opens a lighter copy for reading on screen; the download is the full file">
                        opens {bytes(a.screen_bytes)} · full {bytes(a.bytes)}
                      </span>
                    ) : (
                      <span className="tabular-nums w-16 text-end">{bytes(a.bytes)}</span>
                    )}
                    <a href={fileHref(a, true)} className="underline">
                      {a.screen_key ? "download full file" : "download"}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
    </div>
  );
}
