import type { ReactNode } from "react";

const G = "#2E6B4E";

// Book cover thumbnail (rendered from the PDF's first page) with an SVG fallback.
export function BookCover({ src, title }: { src: string | null; title: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={title}
        className="w-10 h-14 object-cover rounded border border-[#EBE3D3] shrink-0 bg-[#F1ECE0]"
      />
    );
  }
  return (
    <div className="w-10 h-14 rounded border border-[#EBE3D3] bg-[#EAF1EC] flex items-center justify-center shrink-0">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={G} strokeWidth="1.6">
        <path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z" />
        <path d="M4 17a3 3 0 0 1 3-3h11" />
      </svg>
    </div>
  );
}

const PATHS: Record<string, ReactNode> = {
  presentation: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M10 9l4 2.5-4 2.5z" fill={G} stroke="none" />
    </>
  ),
  lesson_plan: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  activity: <path d="M12 3l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4L7.5 16.7l.9-5L4.8 8.2l5-.7z" />,
  worksheet: (
    <>
      <path d="M4 20l1-4L16 5l3 3L8 19z" />
      <path d="M14 7l3 3" />
    </>
  ),
  exam_paper: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M8 8l1.4 1.4L12 7M8 14l1.4 1.4L12 13" />
    </>
  ),
  case_study: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 1 4 10.5c-.8.7-1 1.2-1 2.5H9c0-1.3-.2-1.8-1-2.5A6 6 0 0 1 12 3z" />
    </>
  ),
};

export function TypeIcon({ kind }: { kind: string }) {
  const p = PATHS[kind];
  if (!p) return null;
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke={G}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      {p}
    </svg>
  );
}

export function EmptyBooks() {
  return (
    <svg width="132" height="96" viewBox="0 0 132 96" fill="none" className="mx-auto mb-4">
      <rect x="24" y="18" width="84" height="58" rx="5" fill="#EAF1EC" stroke="#D9CFB8" />
      <path d="M34 30h44M34 41h54M34 52h38" stroke="#B7C9BD" strokeWidth="3" strokeLinecap="round" />
      <circle cx="100" cy="66" r="15" fill="#FBF6EC" stroke={G} strokeWidth="2" />
      <path d="M100 59v14M93 66h14" stroke={G} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
