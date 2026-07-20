import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sessionScoped } from "./session-cookies";

// Supabase client for Server Components, Route Handlers, and Server Actions.
// In Next.js 16 `cookies()` is async and must be awaited.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              // Session-scoped: the login is cleared when the browser closes,
              // never remembered across restarts. See ./session-cookies.ts.
              cookieStore.set(name, value, sessionScoped(options)),
            );
          } catch {
            // setAll called from a Server Component — safe to ignore; the
            // proxy refreshes the session cookie on the next request.
          }
        },
      },
    },
  );
}
