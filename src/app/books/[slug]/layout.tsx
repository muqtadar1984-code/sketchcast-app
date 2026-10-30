import { loadBook } from "./load";
import BookChrome from "./chrome";

export default async function BookLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work, revisions } = await loadBook(slug);
  const current = revisions.find((r) => r.key === work.current_revision);
  return (
    <BookChrome slug={slug} title={work.title} current={current?.label ?? null}>
      {children}
    </BookChrome>
  );
}
