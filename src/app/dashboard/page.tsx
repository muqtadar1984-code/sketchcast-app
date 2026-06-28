import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import UploadBook from "./upload-book";
import GenerateButton from "./generate-button";
import AutoRefresh from "./auto-refresh";

type Book = {
  id: string;
  title: string;
  author: string | null;
  created_at: string;
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#F1ECE0] text-[#6F6A5F]",
  processing: "bg-[#FAEEDA] text-[#854F0B]",
  done: "bg-[#EAF1EC] text-[#2E6B4E]",
  error: "bg-[#FCEBEB] text-[#A32D2D]",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  const schoolId = (profile?.school_id as string | null) ?? null;

  const { data: books } = await supabase
    .from("books")
    .select("id, title, author, created_at")
    .order("created_at", { ascending: false });
  const bookList = (books ?? []) as Book[];

  const { data: gensRaw } = await supabase
    .from("generations")
    .select(
      "id, title, status, created_at, artifacts(kind, storage_path), jobs(progress, status)",
    )
    .order("created_at", { ascending: false });

  // Build signed download URLs for finished artifacts.
  const lessons = await Promise.all(
    (gensRaw ?? []).map(async (g: any) => {
      const arts = await Promise.all(
        (g.artifacts ?? []).map(async (a: any) => {
          const { data } = await supabase.storage
            .from("artifacts")
            .createSignedUrl(a.storage_path, 3600);
          return { kind: a.kind as string, url: data?.signedUrl ?? null };
        }),
      );
      return {
        id: g.id as string,
        title: (g.title as string) || "Untitled lesson",
        status: g.status as string,
        progress: (g.jobs?.[0]?.progress as number) ?? 0,
        arts,
      };
    }),
  );
  const hasPending = lessons.some((l) => l.status === "queued" || l.status === "processing");

  return (
    <div className="min-h-screen bg-[#FBF6EC] text-[#2C2A26]">
      <AutoRefresh active={hasPending} />
      <header className="border-b border-[#EBE3D3] bg-white">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="text-xl font-medium" style={{ fontFamily: "Georgia, serif" }}>
            SketchCast <span className="text-[#2E6B4E]">AI</span>
          </span>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-[#6F6A5F]">
              {profile?.full_name || user.email}
              {profile?.role ? ` · ${profile.role}` : ""}
            </span>
            <form action="/auth/signout" method="post">
              <button className="h-9 px-3 rounded-lg border border-[#EBE3D3] text-[#2C2A26] hover:bg-[#FBF8F1]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-medium mb-1" style={{ fontFamily: "Georgia, serif" }}>
          Your library
        </h1>
        <p className="text-[#6F6A5F] mb-6">
          Upload a textbook, then generate a narrated lesson from it.
        </p>

        <UploadBook schoolId={schoolId} />

        {bookList.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D9CFB8] bg-white p-10 text-center text-[#6F6A5F]">
            No books yet. Upload your first textbook above.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {bookList.map((b) => (
              <div key={b.id} className="bg-white rounded-xl border border-[#EBE3D3] p-5">
                <div className="flex items-start justify-between">
                  <span className="text-xs font-medium text-[#2E6B4E] bg-[#EAF1EC] px-2 py-0.5 rounded-full">
                    PDF
                  </span>
                  <span className="text-xs text-[#6F6A5F]">
                    {new Date(b.created_at).toLocaleDateString()}
                  </span>
                </div>
                <h3 className="mt-3 font-medium" style={{ fontFamily: "Georgia, serif" }}>
                  {b.title}
                </h3>
                <p className="text-sm text-[#6F6A5F]">{b.author || "Unknown author"}</p>
                <GenerateButton bookId={b.id} schoolId={schoolId} />
              </div>
            ))}
          </div>
        )}

        {lessons.length > 0 && (
          <>
            <h2 className="text-2xl font-medium mt-12 mb-4" style={{ fontFamily: "Georgia, serif" }}>
              Lessons
            </h2>
            <div className="space-y-3">
              {lessons.map((l) => {
                const deck = l.arts.find((a) => a.kind === "deck_pptx")?.url;
                const video = l.arts.find((a) => a.kind === "video_mp4")?.url;
                return (
                  <div key={l.id} className="bg-white rounded-xl border border-[#EBE3D3] p-5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-medium" style={{ fontFamily: "Georgia, serif" }}>
                        {l.title}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                        {l.status}
                        {l.status === "processing" ? ` · ${l.progress}%` : ""}
                      </span>
                    </div>
                    {l.status === "processing" && (
                      <div className="h-1.5 bg-[#F1ECE0] rounded-full mt-3 overflow-hidden">
                        <div className="h-full bg-[#2E6B4E]" style={{ width: `${l.progress}%` }} />
                      </div>
                    )}
                    {l.status === "done" && (
                      <div className="flex flex-wrap gap-3 mt-3">
                        {video && (
                          <a href={video} target="_blank" className="text-sm font-medium text-[#2E6B4E] hover:underline">
                            ▶ Watch video
                          </a>
                        )}
                        {deck && (
                          <a href={deck} className="text-sm font-medium text-[#2E6B4E] hover:underline">
                            ⬇ Download deck (.pptx)
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
