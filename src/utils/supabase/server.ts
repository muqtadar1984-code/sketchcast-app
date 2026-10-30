import { cache } from "react";
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

/**
 * The signed-in user for THIS server render, verified once. `auth.getUser()`
 * is a round trip to the Supabase Auth server, and one dashboard render used to
 * pay it five times over (root locale, dashboard layout, page, header, notices
 * card). React `cache` scopes the answer to the request, so every server
 * component in the same render shares one verification. Queries still run on
 * each caller's own session client — this changes who is ASKED, never which
 * client reads or what RLS sees. Render paths only: outside a React render
 * (route handlers, server actions) `cache` does not memoise, so it degrades to
 * a plain getUser().
 */
export const currentUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
