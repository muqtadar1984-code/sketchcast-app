import { createClient } from "@supabase/supabase-js";

// Privileged server-only client (service role → bypasses RLS). Use ONLY in
// Route Handlers / Server Actions for operations the user's session can't do:
// creating student auth users, and signing artifacts shared to a student.
// Never import this into a Client Component. Requires SUPABASE_SERVICE_ROLE_KEY.
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — add it to the server environment (Vercel + .env.local).",
    );
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
