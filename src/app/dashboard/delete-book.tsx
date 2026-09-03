"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import {
  blockedReasonFromError,
  bookDeleteBlockedReason,
  bookDeleteConfirmText,
  type BookImpact,
} from "@/utils/book-delete";
import { type LibraryMessages } from "./labels";

// Delete a book — and, since 0100, everything generated from it.
//
// This used to remove the upload and the books row, and nothing else: the
// kits survived as orphans (generations.book_id is SET NULL), their files
// stayed in storage, and the Library grew an "Other lessons" section to show
// them. The founder's decision on 2026-09-03: a book's kits belong to the
// book.
//
// So the act is now two steps, both answered by the database:
//   1. my_book_impact  — what would go: kits, and any work students submitted
//                        for them. Those numbers go in the confirm, because
//                        "and its kits" is an adjective and "3 kits, 12 pieces
//                        of student work" is a decision.
//   2. DELETE /api/books/:id — delete_my_book through this session (rows),
//                        then the files, with paths the database handed back.
//
// A book still being indexed, or a kit still being built, is refused with a
// reason rather than greyed out silently — a worker mid-write must not have
// its rows pulled away (the 2026-09-02 FK storm).
export default function DeleteBook({
  bookId,
  title,
  t,
}: {
  bookId: string;
  title: string;
  t: LibraryMessages;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const m = t.deleteBook;

  async function onDelete() {
    setBusy(true);
    const supabase = createClient();

    const { data, error } = await supabase.rpc("my_book_impact", { p_book: bookId });
    if (error) {
      alert(error.message || t.common.somethingWentWrong);
      setBusy(false);
      return;
    }
    const impact = data as BookImpact;

    const blocked = bookDeleteBlockedReason(impact);
    if (blocked) {
      alert(m[blocked]);
      setBusy(false);
      return;
    }
    if (!confirm(bookDeleteConfirmText(m, title, impact))) {
      setBusy(false);
      return;
    }

    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // The race the impact check cannot close: a kit that started building
      // between the question and the answer. The RPC's token says which.
      const reason = blockedReasonFromError(body.error);
      alert(reason ? m[reason] : body.error || t.common.somethingWentWrong);
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      aria-label={m.delete}
      title={m.delete}
      className="w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50"
    >
      ✕
    </button>
  );
}
