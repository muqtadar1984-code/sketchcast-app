import { createBrowserClient } from "@supabase/ssr";
import { parse, serialize } from "cookie";
import { sessionScoped } from "./session-cookies";

// Supabase client for use in Client Components (browser).
//
// The cookies adapter mirrors @supabase/ssr's own default document.cookie
// implementation (same `cookie` library), with ONE change: writes are
// session-scoped (no Max-Age) so a login is cleared when the browser closes and
// is never remembered across restarts. See ./session-cookies.ts. The server
// client (server.ts) and the proxy (proxy.ts) strip persistence too, so every
// write site agrees.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          const parsed = parse(document.cookie);
          return Object.keys(parsed).map((name) => ({ name, value: parsed[name] ?? "" }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            document.cookie = serialize(name, value, sessionScoped(options));
          });
        },
      },
    },
  );
}
