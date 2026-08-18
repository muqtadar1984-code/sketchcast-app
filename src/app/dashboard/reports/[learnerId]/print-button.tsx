"use client";

// The report's one interactive control. The browser's print dialog IS the
// export in this release (paper or save-as-PDF) — no docx/pdf generation.
// print:hidden so the button never appears on the record it prints.
export default function PrintButton({ label }: { label: string }) {
  return (
    <button onClick={() => window.print()} className="btn-primary h-9 px-4 text-sm print:hidden">
      {label}
    </button>
  );
}
