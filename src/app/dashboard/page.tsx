import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import UploadBook from "./upload-book";

type Book = {
  id: string;
  title: string;
  author: string | null;
  pages: number | null;
  created_at: string;
  owner_id: string;
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

  const { data: books } = await supabase
    .from("books")
    .select("id, title, author, pages, created_at, owner_id")
    .order("created_at", { ascending: false });

  const list = (books ?? []) as Book[];

  return (
    <div className="min-h-screen bg-[#FBF6EC] text-[#2C2A26]">
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
          Upload a textbook PDF — it's saved to your library and stays put across refreshes.
        </p>

        <UploadBook schoolId={(profile?.school_id as string | null) ?? null} />

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D9CFB8] bg-white p-10 text-center text-[#6F6A5F]">
            No books yet. Upload your first textbook above.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((b) => (
              <div key={b.id} className="bg-white rounded-xl border border-[#EBE3D3] p-5">
                <div className="flex items-start justify-between">
                  <span className="text-xs font-medium text-[#2E6B4E] bg-[#EAF1EC] px-2 py-0.5 rounded-full">
                    PDF
                  </span>
                  <span className="text-xs text-[#6F6A5F]">
                    {new Date(b.created_at).toLocaleDateString()}
                  </span>
                </div>
                <h3 className="mt-3 font-medium text-[#2C2A26]" style={{ fontFamily: "Georgia, serif" }}>
                  {b.title}
                </h3>
                <p className="text-sm text-[#6F6A5F]">{b.author || "Unknown author"}</p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
