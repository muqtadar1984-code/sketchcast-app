// Small shared pieces of the book app's screens. Pure, server-renderable.

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function day(d: string | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const TONES: Record<string, string> = {
  done: "bg-[#E3EEE5] text-[#24543A] border-[#BCD5C2]",
  approved: "bg-[#E3EEE5] text-[#24543A] border-[#BCD5C2]",
  applied: "bg-[#E3EEE5] text-[#24543A] border-[#BCD5C2]",
  open: "bg-[#FBEBD5] text-[#8A4B10] border-[#EDCB9C]",
  accepted: "bg-[#FBEBD5] text-[#8A4B10] border-[#EDCB9C]",
  parked: "bg-[#ECEAE4] text-[#5F5A4E] border-[#D8D3C6]",
  deferred: "bg-[#ECEAE4] text-[#5F5A4E] border-[#D8D3C6]",
  rejected: "bg-[#F3E1DF] text-[#8E2A21] border-[#E2BAB5]",
  failed: "bg-[#F3E1DF] text-[#8E2A21] border-[#E2BAB5]",
  P0: "bg-[#F3E1DF] text-[#8E2A21] border-[#E2BAB5]",
  P1: "bg-[#FBEBD5] text-[#8A4B10] border-[#EDCB9C]",
  P2: "bg-[#ECEAE4] text-[#5F5A4E] border-[#D8D3C6]",
  CONFIRMED: "bg-[#E2E8F3] text-[#28406B] border-[#BCC9E0]",
  SINGLE: "bg-white text-[#5F5A4E] border-[#D8D3C6]",
};

export function Chip({ label, tone }: { label: string; tone?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${TONES[tone ?? label] ?? TONES.parked}`}>
      {label}
    </span>
  );
}

export function Card({ title, children, aside }: { title?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[#E4DCC8] bg-white p-4 sm:p-5">
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          {title && <h2 className="font-display text-base text-[#1F2A24]">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[#7A7363]">{children}</p>;
}
