import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { consoleHostname, bareHost, STAFF_LOGIN_PATH } from "@/utils/console-routing";
import { libraryHostname, LIBRARY_LOGIN_PATH } from "@/utils/library-routing";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  // On the console host, land back on the staff login (the teacher /login isn't
  // served there); everywhere else, the normal login.
  const h = bareHost(request.headers.get("host"));
  const cfgHost = consoleHostname();
  const libHost = libraryHostname();
  const dest = cfgHost && h === cfgHost ? STAFF_LOGIN_PATH : libHost && h === libHost ? LIBRARY_LOGIN_PATH : "/login";
  return NextResponse.redirect(`${origin}${dest}`, { status: 303 });
}
