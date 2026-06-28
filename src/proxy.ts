import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/proxy";

// Next.js 16 renamed `middleware.ts` → `proxy.ts`. Refreshes the Supabase
// session and guards routes on every matched request.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on everything except static assets and image files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
