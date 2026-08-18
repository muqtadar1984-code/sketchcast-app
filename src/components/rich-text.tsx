import { emphasisSegments } from "@/utils/emphasis";

// Chat-bubble text with the models' **bold** and *italic* rendered as real
// emphasis (founder, 2026-08-18 — the bubbles showed raw asterisks). Pure
// React nodes from typed segments: no HTML strings, no injection surface.
// Pair with `whitespace-pre-wrap` on the bubble so the models' line-broken
// bullet lists stack instead of running inline.
export default function RichText({ text }: { text: string }) {
  return (
    <>
      {emphasisSegments(text).map((s, i) =>
        s.bold ? (
          <strong key={i} className={s.italic ? "italic" : undefined}>
            {s.text}
          </strong>
        ) : s.italic ? (
          <em key={i}>{s.text}</em>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
