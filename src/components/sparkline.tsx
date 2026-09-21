// A sparkline: one polyline in an inline SVG, server-safe (no hooks), the
// teal stroke and paper baseline the console already uses. The first hand-
// drawn chart in the codebase, kept deliberately plain — the numbers beside
// it are the reading; this is the shape.

export default function Sparkline({
  values,
  width = 160,
  height = 36,
  stroke = "#1FB8A6",
  className,
  title,
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
  /** Accessible name, e.g. "Views per day, last 30 days". */
  title?: string;
}) {
  const n = values.length;
  const max = Math.max(1, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1);
    const y = height - pad - ((Number.isFinite(v) ? v : 0) / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={title}
      preserveAspectRatio="none"
    >
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#EEF0EC" strokeWidth="1" />
      {n > 0 && (
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
