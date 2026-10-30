import { createAdminClient } from "@/utils/supabase/admin";
import { founderEmails } from "@/utils/platform-admin";
import { founderImportCard, type ReleaseImportRow, type ReleaseImportsDb } from "@/utils/my-books/release-imports";
import ImportNowButton from "./import-now-button";

// SK S7 K3 — the founder's "Import now" card on console → Content: the book
// app's live releases, SK's last import of each, and the button (K1's import
// route). FOUNDER_EMAILS only — other staff see nothing, and nothing is read
// for them. Drafts are listed as skipped and never offered (founder
// 2026-10-30: only completed books).

const STATUS: Record<ReleaseImportRow["status"], { label: string; cls: string }> = {
  ok: { label: "imported", cls: "bg-[#E2F4F1] text-[#0C8175]" },
  error: { label: "failed", cls: "bg-[#FFE9E3] text-[#B3401F]" },
  skipped: { label: "skipped", cls: "bg-[#F5F6F3] text-[#5B6470]" },
  never: { label: "not imported yet", cls: "bg-[#FFF9EE] text-[#9A6400]" },
  draft_skipped: { label: "skipped (drafts not used)", cls: "bg-[#F5F6F3] text-[#5B6470]" },
};

const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");

export default async function ReleaseImportsCard({ email }: { email: string | null | undefined }) {
  const data = await founderImportCard(email, founderEmails(), () => createAdminClient() as unknown as ReleaseImportsDb);
  if (!data) return null;
  const finals = data.rows.filter((r) => r.kind === "final").length;

  return (
    <section className="mb-8 rounded-xl border border-[#E4E7E2] bg-white p-4 sm:p-5" aria-labelledby="release-imports-title">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="release-imports-title" className="text-lg font-semibold">
            SketchCast book releases → SK
          </h2>
          <p className="text-sm text-[#5B6470]">
            Live releases from the book app and SK&apos;s last import of each. Only final releases are imported; drafts are not used. The daily cron imports too.
          </p>
        </div>
        <ImportNowButton disabled={data.state !== "ok"} />
      </div>
      {data.state === "waiting_for_book_app" && <p className="text-sm text-[#9A6400]">Waiting for the book app: pub_releases (its migration 0172) is not there yet.</p>}
      {data.state === "error" && <p className="text-sm text-[#B3401F]">Could not read the releases: {data.message}</p>}
      {data.state === "ok" && !data.migration0174 && (
        <p className="mb-3 rounded-lg bg-[#FFF9EE] px-3 py-2 text-sm text-[#9A6400]">SK&apos;s migration 0174 is not applied: nothing can be imported yet.</p>
      )}
      {data.state === "ok" && data.rows.length === 0 && <p className="text-sm text-[#5B6470]">No live releases.</p>}
      {data.state === "ok" && data.rows.length > 0 && (
        <>
          {finals === 0 && <p className="mb-2 text-sm text-[#5B6470]">No live final release yet — nothing to import.</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-start text-xs uppercase tracking-wide text-[#5B6470]">
                  <th className="py-1.5 pe-3 text-start font-medium">Release</th>
                  <th className="py-1.5 pe-3 text-start font-medium">Book</th>
                  <th className="py-1.5 pe-3 text-start font-medium">Kind</th>
                  <th className="py-1.5 pe-3 text-start font-medium">Released</th>
                  <th className="py-1.5 text-start font-medium">Last import</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-[#EEF0EC] align-top">
                    <td className="py-2 pe-3 tabular-nums">#{r.id}</td>
                    <td className="py-2 pe-3">
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-[#98A0A9]">
                        {r.slug} · {r.language} · {r.editionKey}
                      </div>
                    </td>
                    <td className="py-2 pe-3">{r.kind}</td>
                    <td className="py-2 pe-3 whitespace-nowrap">{when(r.releasedAt)}</td>
                    <td className="py-2">
                      <span className={`chip font-sans ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      {r.kind === "final" && r.importedAt && (
                        <div className="mt-1 text-xs text-[#98A0A9]">
                          {when(r.importedAt)}
                          {r.blocks != null && r.status === "ok" ? ` · ${r.blocks} passages` : ""}
                        </div>
                      )}
                      {r.error && <div className="mt-1 max-w-md break-words text-xs text-[#B3401F]">{r.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
