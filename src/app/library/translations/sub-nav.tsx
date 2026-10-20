import Link from "next/link";

// The two views of the Translations tab: the topics × languages matrix and
// the list of translated videos with their YouTube state (2026-10-20). The
// header tab stays "Translations" for both (library-header.tsx matches by
// prefix).
const VIEWS = [
  { key: "matrix", href: "/library/translations", label: "Matrix" },
  { key: "youtube", href: "/library/translations/youtube", label: "YouTube videos" },
] as const;

export function TranslationsNav({ active }: { active: (typeof VIEWS)[number]["key"] }) {
  return (
    <nav aria-label="Translations views" className="flex gap-1 mb-5 text-sm">
      {VIEWS.map((v) => (
        <Link
          key={v.key}
          href={v.href}
          aria-current={v.key === active ? "page" : undefined}
          className={
            v.key === active
              ? "rounded-full px-3 py-1 bg-[#14241E] text-white font-medium"
              : "rounded-full px-3 py-1 text-[#5B6470] hover:text-[#14181F] hover:bg-[#EEF0EC]"
          }
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}
