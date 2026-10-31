// SK's chat text, rendered (student Board phase 3, 2026-10-31): headings,
// paragraphs, numbered / bulleted lists, **bold** / *italic*, and MATHS —
// inline ($…$) and on its own line ($$…$$) — from the typed blocks of
// src/sk/shell/client/rich-blocks.ts. Plain React nodes only: no HTML strings,
// no injection surface, no maths library to download (the subset is drawn
// with Unicode and a little CSS: tex.ts says why). A reply with none of the
// markup renders as it always did (RichText: emphasis, line breaks kept).
//
// Phone-friendly: a display formula scrolls sideways inside its own line
// instead of widening the chat sheet.

import { Fragment, type ReactNode } from "react";
import RichText from "@/components/rich-text";
import { hasMarkup, parseBlocks, type Inline } from "@/sk/shell/client/rich-blocks";
import { texPlain, type TexNode } from "@/sk/shell/client/tex";

function Tex({ nodes }: { nodes: TexNode[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "sym":
        return n.italic ? (
          <i key={i} className="font-serif">
            {n.v}
          </i>
        ) : (
          <span key={i} className={/[=+−×÷±≤≥≠≈<>→⇒·]/.test(n.v) ? "mx-[0.2em]" : undefined}>
            {n.v}
          </span>
        );
      case "text":
        return <span key={i}>{n.v}</span>;
      case "group":
        return (
          <Fragment key={i}>
            <Tex nodes={n.body} />
          </Fragment>
        );
      case "frac":
        return (
          <span key={i} className="mx-[0.15em] inline-flex flex-col items-center align-middle text-[0.85em] leading-[1.15]" data-sk-math="frac">
            <span className="px-[0.2em]">
              <Tex nodes={n.num} />
            </span>
            <span className="w-full border-t border-current px-[0.2em] text-center">
              <Tex nodes={n.den} />
            </span>
          </span>
        );
      case "sqrt":
        return (
          <span key={i} className="whitespace-nowrap" data-sk-math="sqrt">
            {n.index && (
              <sup className="text-[0.6em]">
                <Tex nodes={n.index} />
              </sup>
            )}
            √
            <span className="border-t border-current pt-[0.05em]">
              <Tex nodes={n.body} />
            </span>
          </span>
        );
      case "sup":
        return (
          <sup key={i} className="text-[0.7em]">
            <Tex nodes={n.body} />
          </sup>
        );
      case "sub":
        return (
          <sub key={i} className="text-[0.7em]">
            <Tex nodes={n.body} />
          </sub>
        );
    }
  });
}

/** One formula: drawn, with its plain form as the accessible name. */
function MathRun({ nodes, display }: { nodes: TexNode[]; display?: boolean }) {
  const label = texPlain(nodes);
  return display ? (
    <span className="my-1 block overflow-x-auto whitespace-nowrap text-center text-[1.05em]" role="math" aria-label={label} data-sk-math="block">
      <Tex nodes={nodes} />
    </span>
  ) : (
    <span className="whitespace-nowrap" role="math" aria-label={label} data-sk-math="inline">
      <Tex nodes={nodes} />
    </span>
  );
}

function Runs({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) =>
        r.kind === "math" ? (
          <MathRun key={i} nodes={r.tex} display={r.display} />
        ) : r.bold ? (
          <strong key={i} className={r.italic ? "italic" : undefined}>
            {r.text}
          </strong>
        ) : r.italic ? (
          <em key={i}>{r.text}</em>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

export default function SkRichText({ text }: { text: string }) {
  if (!hasMarkup(text)) return <RichText text={text} />;
  const blocks = parseBlocks(text);
  return (
    <span className="block space-y-1.5 whitespace-normal" data-sk="rich">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <span key={i} className="block font-semibold text-[1.02em]" role="heading" aria-level={4}>
                <Runs runs={b.inline} />
              </span>
            );
          case "para":
            return (
              <span key={i} className="block">
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    <Runs runs={l} />
                  </Fragment>
                ))}
              </span>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal space-y-0.5 ps-5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Runs runs={it} />
                  </li>
                ))}
              </ol>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-0.5 ps-5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Runs runs={it} />
                  </li>
                ))}
              </ul>
            );
          case "math":
            return <MathRun key={i} nodes={b.tex} display />;
        }
      })}
    </span>
  );
}
