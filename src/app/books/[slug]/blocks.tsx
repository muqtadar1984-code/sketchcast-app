import RichText from "@/components/rich-text";
import type { Annotation, Block, Exercise, FigureInfo } from "@/utils/books/types";

// How each manuscript block reads on screen. A faithful READ view of the typed
// blocks — not the print layout (the PDFs in Files are that). Text is rendered
// through RichText (typed segments, no HTML strings).

export type FigureCtx = {
  src: (ref: string) => string;
  figures: Record<string, FigureInfo>;
  annotations: Map<string, Annotation["body"]>;
};

function T({ text }: { text?: string | null }) {
  return text ? <RichText text={String(text)} /> : null;
}

function Credit({ f }: { f?: FigureInfo }) {
  const c = f?.credit;
  if (!c || c.note) return null;
  return (
    <span className="block text-[11px] text-[#7A7363] mt-0.5">
      {[c.author, c.licence, c.provider].filter(Boolean).join(" · ")}
    </span>
  );
}

export function Picture({ refId, caption, ctx, compact }: { refId: string; caption?: string; ctx: FigureCtx; compact?: boolean }) {
  const f = ctx.figures[refId];
  const ann = ctx.annotations.get(refId);
  const size = ann?.size ?? (f?.size?.[0] && f?.size?.[1] ? [f.size[0], f.size[1]] : null);
  const anchors = ann?.anchors ? Object.entries(ann.anchors) : [];
  return (
    <figure className={compact ? "" : "my-4"} data-figref={f ? refId : undefined}>
      <div className="inline-block max-w-full rounded-lg border border-[#EFE8D8] bg-[#FDFBF5] p-2">
        {f ? (
          // The frame keeps the picture's real proportions, so label points sit right while it loads, and the
          // caption shows through if the picture cannot be fetched.
          <div
            className="relative max-w-full"
            style={size ? { aspectRatio: `${size[0]} / ${size[1]}`, width: compact ? `${Math.round((160 * size[0]) / size[1])}px` : `${Math.min(size[0], 560)}px` } : undefined}
          >
            <span className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-[#9A9383]">{caption ?? f.caption ?? refId}</span>
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed links, not optimisable */}
            <img
              src={ctx.src(refId)}
              alt={caption ?? f.caption ?? ""}
              className={size ? "absolute inset-0 h-full w-full object-contain" : `relative block max-w-full ${compact ? "max-h-40" : "max-h-96"} h-auto`}
              loading="lazy"
            />
            {size && anchors.length > 0 && (
              <div className="absolute inset-0" aria-hidden>
                {anchors.map(([name, [x, y]], i) => (
                  <span
                    key={name}
                    className="absolute -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-[#B8862F] text-white text-[9px] leading-4 text-center shadow"
                    style={{ left: `${(x / size[0]) * 100}%`, top: `${(y / size[1]) * 100}%` }}
                    title={name}
                  >
                    {i + 1}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="w-64 h-32 grid place-items-center text-xs text-[#7A7363]">Picture not in this revision&apos;s records</div>
        )}
      </div>
      {anchors.length > 0 && (
        <ol className="mt-1 text-xs text-[#5F5A4E] flex flex-wrap gap-x-3">
          {anchors.map(([name], i) => (
            <li key={name}>
              <span className="text-[#B8862F] font-medium">{i + 1}</span> {name}
            </li>
          ))}
          {ann?.unverified?.length ? <li className="text-[#8A4B10]">unverified: {ann.unverified.join(", ")}</li> : null}
        </ol>
      )}
      {(caption || f?.caption) && (
        <figcaption className="text-sm text-[#5F5A4E] mt-1 max-w-xl">
          <T text={caption ?? f?.caption} />
          <Credit f={f} />
        </figcaption>
      )}
    </figure>
  );
}

export function BlockView({ b, ctx }: { b: Block; ctx: FigureCtx }) {
  switch (b.type) {
    case "paragraph":
      return (
        <p className="my-3 leading-relaxed">
          <T text={b.text} />
        </p>
      );
    case "key_term":
      return (
        <div className="my-3 rounded-lg border-s-4 border-[#3F7D5A] bg-[#EEF4EF] px-4 py-2.5">
          <strong>
            <T text={b.term} />
          </strong>{" "}
          — <T text={b.text} />
        </div>
      );
    case "key_idea":
      return (
        <div className="my-3 rounded-lg bg-[#E7EFE9] px-4 py-2.5 font-medium">
          <span className="text-xs uppercase tracking-wide text-[#24543A] block mb-0.5">Key idea</span>
          <T text={b.text} />
        </div>
      );
    case "misconception":
      return (
        <div className="my-3 rounded-lg border border-[#EDCB9C] bg-[#FBF1E2] px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-[#8A4B10] block mb-1">Common mistake</span>
          <p className="line-through decoration-[#C47A3A]/60">
            <T text={b.wrong} />
          </p>
          <p className="mt-1">
            <T text={b.right} />
          </p>
        </div>
      );
    case "worked_example":
      return (
        <div className="my-3 rounded-lg border border-[#E4DCC8] bg-white px-4 py-3">
          <span className="text-xs uppercase tracking-wide text-[#7A7363] block mb-1">Worked example</span>
          <p>
            <T text={b.problem} />
          </p>
          <ol className="list-decimal ms-5 my-2 space-y-1">
            {(b.steps ?? []).map((s, i) => (
              <li key={i}>
                <T text={s} />
              </li>
            ))}
          </ol>
          <p>
            <strong>Answer:</strong> <T text={b.answer} />
          </p>
        </div>
      );
    case "think":
      return (
        <div className="my-3 rounded-lg bg-[#E6F1F2] px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-[#2B7A7F] block mb-0.5">Think about it</span>
          <T text={b.text} />
          {b.answer && (
            <details className="mt-1 text-sm text-[#3C5F61]">
              <summary className="cursor-pointer">Answer (printed at the back)</summary>
              <T text={b.answer} />
            </details>
          )}
        </div>
      );
    case "extension":
      return (
        <div className="my-3 rounded-lg border border-[#9FB3BF] bg-[#ECF1F4] px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-[#4F6672] block mb-0.5">Extension — beyond the objective, not assessed</span>
          <T text={b.text} />
        </div>
      );
    case "list": {
      const items = (b.items ?? []).map((i, k) => (
        <li key={k}>
          <T text={typeof i === "string" ? i : i.label} />
        </li>
      ));
      return b.ordered ? <ol className="list-decimal ms-6 my-3 space-y-1">{items}</ol> : <ul className="list-disc ms-6 my-3 space-y-1">{items}</ul>;
    }
    case "table":
      return (
        <figure className="my-4 overflow-x-auto">
          <table className="text-sm border-collapse">
            <thead>
              <tr>
                {(b.headers ?? []).map((h, i) => (
                  <th key={i} className="border border-[#E4DCC8] bg-[#F4EEDF] px-2.5 py-1.5 text-left font-medium">
                    <T text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(b.rows ?? []).map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border border-[#E4DCC8] px-2.5 py-1.5 align-top">
                      <T text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {b.caption && (
            <figcaption className="text-sm text-[#5F5A4E] mt-1">
              <T text={b.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "figure":
      return b.ref ? <Picture refId={b.ref} caption={b.caption} ctx={ctx} /> : null;
    case "figure_group": {
      const items = (b.items ?? []).filter((i): i is { ref?: string; label?: string } => typeof i === "object");
      return (
        <figure className="my-4">
          <div className="flex flex-wrap gap-3">
            {items.map((it, i) => (
              <div key={i} className="text-center">
                {it.ref && <Picture refId={it.ref} ctx={ctx} compact />}
                <span className="text-xs font-medium">
                  {String.fromCharCode(65 + i)}. {it.label}
                </span>
              </div>
            ))}
          </div>
          {(b.relations ?? []).length > 0 && (
            <ul className="text-xs text-[#5F5A4E] mt-1">
              {(b.relations ?? []).map((r, i) => (
                <li key={i}>
                  {String.fromCharCode(65 + r.from)} → {String.fromCharCode(65 + r.to)}
                  {r.kind ? ` (${r.kind})` : ""}
                  {r.label ? `: ${r.label}` : ""}
                </li>
              ))}
            </ul>
          )}
          {b.caption && (
            <figcaption className="text-sm text-[#5F5A4E] mt-1">
              <T text={b.caption} />
            </figcaption>
          )}
        </figure>
      );
    }
    default:
      return <pre className="my-3 text-xs bg-[#F4EEDF] p-2 rounded overflow-x-auto">{JSON.stringify(b, null, 1)}</pre>;
  }
}

export function ExerciseView({ x, n, ctx }: { x: Exercise; n: number; ctx: FigureCtx }) {
  const pics = [x.figure_ref, ...(x.figure_refs ?? [])].filter((r): r is string => !!r);
  return (
    <li className="py-3 border-t border-[#EFE8D8] first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#7A7363] mb-1">
        <span className="font-medium text-[#1F2A24]">Q{n}</span>
        {x.tier && <span>{x.tier}</span>}
        {x.item_type && <span>· {x.item_type.replace(/_/g, " ")}</span>}
      </div>
      <p>
        <T text={x.stem} />
      </p>
      {pics.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2">
          {pics.map((r, i) => (
            <div key={r} className="text-xs">
              <Picture refId={r} ctx={ctx} compact />
              {pics.length > 1 && <span className="font-medium">{String.fromCharCode(65 + i)}</span>}
              {x.figure_context?.[String.fromCharCode(65 + i)] && <span className="text-[#7A7363]"> — {x.figure_context[String.fromCharCode(65 + i)]}</span>}
            </div>
          ))}
        </div>
      )}
      {x.options && (
        <ol className="list-[lower-alpha] ms-6 mt-1">
          {x.options.map((o, i) => (
            <li key={i}>
              <T text={o} />
            </li>
          ))}
        </ol>
      )}
      {x.pairs && (
        <table className="text-sm mt-1">
          <tbody>
            {x.pairs.map((p, i) => (
              <tr key={i}>
                <td className="pe-4 align-top">
                  <T text={p.left} />
                </td>
                <td className="align-top text-[#5F5A4E]">
                  <T text={p.right} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {x.categories && x.items && (
        <p className="text-sm mt-1 text-[#5F5A4E]">
          Sort into {x.categories.join(" / ")}: {x.items.map((i) => i.text).join("; ")}
        </p>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-[#7A7363]">Answer and mark scheme</summary>
        <div className="mt-1 rounded bg-[#F7F3E8] px-3 py-2">
          <p>
            <T text={x.answer} />
          </p>
          {(x.marking_scheme ?? []).length > 0 && (
            <ul className="list-disc ms-5 mt-1">
              {(x.marking_scheme ?? []).map((m, i) => (
                <li key={i}>
                  <T text={m.point} />
                  {m.marks ? ` (${m.marks})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}
