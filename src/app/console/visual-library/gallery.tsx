"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  SORTS,
  STATUSES,
  type Filters,
  type GalleryItem,
  type SortKey,
  withFilter,
} from "@/utils/visual-library";

// The grid + detail modal. Image-first: the artwork is the card, metadata is a
// caption under it and the full story is in the modal. An asset-management
// tool, not a table with a thumbnail column.
//
// Every filter is a LINK (a GET with querystring), so the server re-queries and
// paginates. Nothing filters client-side, because the browser never holds more
// than one page.

type Facets = { subjects: string[]; grades: string[]; curricula: string[]; topics: string[] };

const STATUS_TONE: Record<string, string> = {
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  candidate: "bg-[#FFF1D6] text-[#9A6400]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
  retired: "bg-[#EEF0EC] text-[#5B6470]",
};

export default function Gallery({
  items,
  filters,
  facets,
  total,
  pages,
  pageSize,
  missing,
  duplicates,
  filtered,
}: {
  items: GalleryItem[];
  filters: Filters;
  facets: Facets;
  total: number;
  pages: number;
  pageSize: number;
  missing: number;
  duplicates: string[];
  filtered: boolean;
}) {
  const [open, setOpen] = useState<GalleryItem | null>(null);
  const dupes = new Set(duplicates);

  // Escape closes the modal — the brief asks for an obvious way back, and a
  // keyboard user should not have to find the button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const from = (filters.page - 1) * pageSize;

  return (
    <>
      <FilterBar filters={filters} facets={facets} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[#5B6470] mb-4">
        <span>
          {total.toLocaleString()} asset{total === 1 ? "" : "s"}
          {total > 0 && (
            <>
              {" "}
              · showing {from + 1}–{Math.min(from + items.length, total)}
            </>
          )}
        </span>
        {missing > 0 && (
          <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F]">
            {missing} image{missing === 1 ? "" : "s"} unavailable
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-[#5B6470]">
            {filtered
              ? "No assets match these filters."
              : "The library has no assets yet. Generated visuals appear here once the worker promotes them."}
          </p>
          {filtered && (
            <Link href="/console/visual-library" className="btn-ghost h-9 px-3 text-sm inline-flex items-center mt-4">
              Clear filters
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((it) => (
            <Card
              key={it.asset.id}
              item={it}
              duplicate={dupes.has(it.asset.canonical_key)}
              onOpen={() => setOpen(it)}
            />
          ))}
        </div>
      )}

      {pages > 1 && <Pager filters={filters} pages={pages} />}
      {open && <Detail item={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TypeChip({ type }: { type: "visual" | "avatar" }) {
  // Avatars must never be mistaken for teaching artwork, so the distinction is
  // always on the card, never only in a filter.
  return (
    <span
      className={
        "chip font-sans " +
        (type === "avatar" ? "bg-[#EDE7FB] text-[#5B3FBF]" : "bg-[#E6F1FB] text-[#1F5B99]")
      }
    >
      {type === "avatar" ? "Avatar" : "Visual"}
    </span>
  );
}

function Card({
  item,
  duplicate,
  onOpen,
}: {
  item: GalleryItem;
  duplicate: boolean;
  onOpen: () => void;
}) {
  const a = item.asset;
  const avatar = a.asset_type === "avatar";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card card-hover overflow-hidden text-left flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1FB8A6]"
      aria-label={`Inspect ${a.canonical_key}`}
    >
      {/* Line art is judged against white — a tinted panel hides thin strokes
          and grey fills, which is exactly what this tool exists to catch. */}
      <div className="relative bg-white aspect-4/3 flex items-center justify-center border-b border-[#EEF0EC]">
        <Thumb url={item.url} alt={a.description || a.canonical_key} />
        <span className="absolute top-2 left-2">
          <TypeChip type={a.asset_type} />
        </span>
        {a.status !== "approved" && (
          <span className={"absolute top-2 right-2 chip font-sans " + (STATUS_TONE[a.status] ?? "")}>
            {a.status}
          </span>
        )}
      </div>
      <div className="px-4 py-3 min-w-0">
        <p className="font-medium truncate" title={a.canonical_key}>
          {a.canonical_key}
        </p>
        <p className="text-xs text-[#5B6470] truncate">
          {avatar
            ? [a.role, a.age_band].filter(Boolean).join(" · ") || "avatar"
            : [a.subject, a.grade, a.curriculum].filter(Boolean).join(" · ")}
        </p>
        {!avatar && a.topic && <p className="text-xs text-[#98A0A9] truncate mt-0.5">{a.topic}</p>}
        {duplicate && (
          <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400] mt-2 inline-block">
            duplicate key
          </span>
        )}
      </div>
    </button>
  );
}

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span className="text-xs text-[#98A0A9] px-4 text-center">
        {url ? "Image failed to load" : "No image in storage"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      // Lazy + async so a page of 24 does not block paint, and offscreen rows
      // never fetch at all.
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className="max-h-full max-w-full object-contain p-3"
    />
  );
}

function Select({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <label className="text-xs text-[#5B6470]">
      <span className="block mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className="field h-9 px-2 text-sm min-w-36"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterBar({ filters, facets }: { filters: Filters; facets: Facets }) {
  const router = useRouter();
  const go = (patch: Partial<Filters>) =>
    router.push(`/console/visual-library${withFilter(filters, patch)}`);
  const anyOpt = (label: string, values: string[]) => [
    { value: "", label: `All ${label}` },
    ...values.map((v) => ({ value: v, label: v })),
  ];

  return (
    <div className="card p-4 mb-5 space-y-4">
      <form
        method="get"
        action="/console/visual-library"
        className="flex flex-wrap items-end gap-3"
      >
        <label className="text-xs text-[#5B6470] flex-1 min-w-56">
          <span className="block mb-1">Search key, topic or description</span>
          <input
            name="q"
            defaultValue={filters.q}
            placeholder="photosynthesis, sk_hammer, teacher…"
            className="field w-full h-9 px-3 text-sm"
          />
        </label>
        {/* The other filters ride along as hidden fields so a search does not
            silently discard them — the brief asks that filters COMBINE. */}
        {filters.type !== "all" && <input type="hidden" name="type" value={filters.type} />}
        {filters.subject && <input type="hidden" name="subject" value={filters.subject} />}
        {filters.grade && <input type="hidden" name="grade" value={filters.grade} />}
        {filters.curriculum && <input type="hidden" name="curriculum" value={filters.curriculum} />}
        {filters.topic && <input type="hidden" name="topic" value={filters.topic} />}
        {filters.status && <input type="hidden" name="status" value={filters.status} />}
        {filters.concept && <input type="hidden" name="concept" value={filters.concept} />}
        {filters.sort !== "newest" && <input type="hidden" name="sort" value={filters.sort} />}
        <button type="submit" className="btn-primary h-9 px-4 text-sm">
          Search
        </button>
      </form>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-lg bg-[#F3F5F2] p-1">
          {(["all", "visual", "avatar"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => go({ type: t })}
              aria-pressed={filters.type === t}
              className={
                "h-8 px-3 rounded-md text-sm " +
                (filters.type === t ? "bg-white shadow-sm font-medium" : "text-[#5B6470]")
              }
            >
              {t === "all" ? "All" : t === "visual" ? "Educational visuals" : "Avatars"}
            </button>
          ))}
        </div>

        <Select
          label="Subject"
          value={filters.subject}
          options={anyOpt("subjects", facets.subjects)}
          onPick={(v) => go({ subject: v })}
        />
        <Select
          label="Grade / age band"
          value={filters.grade}
          options={anyOpt("grades", facets.grades)}
          onPick={(v) => go({ grade: v })}
        />
        <Select
          label="Curriculum"
          value={filters.curriculum}
          options={anyOpt("curricula", facets.curricula)}
          onPick={(v) => go({ curriculum: v })}
        />
        <Select
          label="Topic"
          value={filters.topic}
          options={anyOpt("topics", facets.topics)}
          onPick={(v) => go({ topic: v })}
        />
        <Select
          label="Status"
          value={filters.status}
          options={[
            { value: "", label: "Any status" },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
          onPick={(v) => go({ status: v })}
        />
        <Select
          label="Sort"
          value={filters.sort}
          options={(Object.keys(SORTS) as SortKey[]).map((k) => ({
            value: k,
            label: SORTS[k].label,
          }))}
          onPick={(v) => go({ sort: v as SortKey })}
        />
        {filters.concept && (
          <button
            type="button"
            onClick={() => go({ concept: "" })}
            className="chip font-sans bg-[#E6F1FB] text-[#1F5B99] h-8"
          >
            concept: {filters.concept} ✕
          </button>
        )}
        <Link href="/console/visual-library" className="btn-ghost h-9 px-3 text-sm inline-flex items-center">
          Reset
        </Link>
      </div>
    </div>
  );
}

function Pager({ filters, pages }: { filters: Filters; pages: number }) {
  const page = filters.page;
  return (
    <nav className="flex items-center justify-center gap-3 mt-8 text-sm" aria-label="Pagination">
      {page > 1 ? (
        <Link
          href={`/console/visual-library${withFilter(filters, { page: page - 1 })}`}
          className="btn-ghost h-9 px-3 inline-flex items-center"
        >
          ← Previous
        </Link>
      ) : (
        <span className="h-9 px-3 inline-flex items-center text-[#98A0A9]">← Previous</span>
      )}
      <span className="text-[#5B6470]">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link
          href={`/console/visual-library${withFilter(filters, { page: page + 1 })}`}
          className="btn-ghost h-9 px-3 inline-flex items-center"
        >
          Next →
        </Link>
      ) : (
        <span className="h-9 px-3 inline-flex items-center text-[#98A0A9]">Next →</span>
      )}
    </nav>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="py-1.5 border-b border-[#EEF0EC] last:border-0">
      <dt className="text-xs text-[#98A0A9]">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function Detail({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const a = item.asset;
  const avatar = a.asset_type === "avatar";
  const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#14181F]/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={a.canonical_key}
        className="relative card w-full max-w-5xl max-h-[90vh] overflow-auto"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-white/95 backdrop-blur px-5 py-3 border-b border-[#EEF0EC]">
          <span className="flex items-center gap-2 min-w-0">
            <TypeChip type={a.asset_type} />
            <span className="font-medium truncate">{a.canonical_key}</span>
            <span className={"chip font-sans " + (STATUS_TONE[a.status] ?? "")}>{a.status}</span>
          </span>
          <button type="button" onClick={onClose} className="btn-ghost h-9 px-3 text-sm shrink-0">
            Close ✕
          </button>
        </div>

        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {/* Neutral white stage: line art has to be judged on the background it
              will be drawn on. */}
          <div className="bg-white rounded-xl border border-[#EEF0EC] min-h-72 flex items-center justify-center p-4">
            <BigImage url={item.url} alt={a.description || a.canonical_key} />
          </div>

          <dl className="min-w-0">
            <Field label="Asset key">{a.asset_key}</Field>
            <Field label="Canonical key">{a.canonical_key}</Field>
            <Field label="Description">{a.description}</Field>
            {avatar ? (
              <>
                <Field label="Role">{a.role ?? ""}</Field>
                <Field label="Age band">{a.age_band ?? ""}</Field>
              </>
            ) : (
              <>
                <Field label="Subject">{a.subject}</Field>
                <Field label="Grade">{a.grade}</Field>
                <Field label="Age band">{a.age_band ?? ""}</Field>
                <Field label="Curriculum">{a.curriculum}</Field>
                <Field label="Topic">{a.topic}</Field>
                <Field label="Concepts">
                  {a.concepts?.length ? (
                    <span className="flex flex-wrap gap-1.5 mt-1">
                      {a.concepts.map((c) => (
                        <Link
                          key={c}
                          href={`/console/visual-library?concept=${encodeURIComponent(c)}`}
                          className="chip font-sans bg-[#EEF0EC] text-[#14181F] hover:bg-[#E1E5E0]"
                        >
                          {c}
                        </Link>
                      ))}
                    </span>
                  ) : (
                    ""
                  )}
                </Field>
              </>
            )}
            <Field label="Provenance">{a.provenance}</Field>
            <Field label="Source">{a.source ?? ""}</Field>
            <Field label="Quality">{a.quality ?? ""}</Field>
            <Field label="Times used">
              {a.usage_count > 0 || a.last_used_at
                ? `${a.usage_count}${a.last_used_at ? ` · last ${when(a.last_used_at)}` : ""}`
                : "never used"}
            </Field>
            <Field label="Created">{when(a.created_at)}</Field>
            <Field label="Updated">{when(a.updated_at)}</Field>
            <Field label="Storage path">
              <code className="text-xs break-all">{a.storage_path ?? "— not in storage —"}</code>
            </Field>
            <Field label="Content hash">
              <code className="text-xs break-all">{a.content_hash ?? ""}</code>
            </Field>
          </dl>
        </div>
      </div>
    </div>
  );
}

function BigImage({ url, alt }: { url: string | null; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <p className="text-sm text-[#98A0A9] text-center px-6">
        {url
          ? "The image could not be loaded from storage."
          : "This row has no storage_path — the metadata exists but no binary is stored."}
      </p>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      onError={() => setBroken(true)}
      className="max-h-[70vh] max-w-full object-contain"
    />
  );
}
