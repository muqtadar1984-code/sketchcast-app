import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Returns a short-lived signed URL for a student's uploaded submission file.
// RLS gates the read (sub_teacher_read → only submissions for the teacher's own
// generations resolve), then the service role signs the object (the submissions
// storage policy only lets the student-owner sign directly).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: sub } = await supabase
    .from("submissions")
    .select("file_path")
    .eq("id", id)
    .maybeSingle();
  if (!sub?.file_path) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  const { data } = await admin.storage.from("submissions").createSignedUrl(sub.file_path, 3600);
  return NextResponse.json({ url: data?.signedUrl ?? null });
}
