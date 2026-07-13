import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { consoleHostname, bareHost, STAFF_LOGIN_PATH } from "@/utils/console-routing";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  // On the console host, land back on the staff login (the teacher /login isn't
  // served there); everywhere else, the normal login.
  const cfgHost = consoleHostname();
  const onConsoleHost = cfgHost && bareHost(request.headers.get("host")) === cfgHost;
  const dest = onConsoleHost ? STAFF_LOGIN_PATH : "/login";
  return NextResponse.redirect(`${origin}${dest}`, { status: 303 });
}
