import Link from "next/link";
import { Card } from "../ui";

// What a chapter page shows for a book with no drafted chapters yet (a book still being planned): where it stands
// is on the Pipeline tab (readiness re-check, then drafting once it is 100% ready).
export default function NotDrafted({ slug }: { slug: string }) {
  return (
    <Card>
      <p className="text-sm text-[#5F5A4E]">
        No chapters yet: this book has not been drafted. Its readiness to draft — which catalogue articles it still needs — is on the{" "}
        <Link href={`/books/${slug}/runs`} className="underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]">
          Pipeline
        </Link>{" "}
        tab (Readiness re-check).
      </p>
    </Card>
  );
}
