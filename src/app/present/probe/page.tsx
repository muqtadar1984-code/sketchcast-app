import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { presentAllowed } from "@/utils/flags";
import ProbeClient from "./probe-client";

export const dynamic = "force-dynamic";

// Present mode, Phase 0 — the ink-latency probe (docs/PRESENT-MODE.md).
//
// This page exists to answer ONE question before any of the board is written:
// does live ink feel immediate on the hardware a school actually owns? It is
// deployed to production on purpose, because the only way to find out is to
// open it on a wall-mounted panel in a real room — a laptop tells us nothing
// about the panel, and the panel is the product.
//
// THE GATE. `presentAllowed` reads a server-only allowlist that is empty by
// default, so this surface is invisible to everyone else in production. The
// redirect here is the weakest of the three gates and is only about not showing
// a half-built surface: /api/present/* 404s independently, and RLS confines
// present_probe rows to the teacher who wrote them. A signed-out visitor goes to
// /login rather than /dashboard so a bookmarked URL survives a session expiring.
//
// NOT TRANSLATED, deliberately. Every user-facing surface in this app runs
// through the ten-locale dictionary; this one is measurement scaffolding read by
// one person and deleted when Phase 0 closes, and adding ~60 keys to ten message
// files for it would be pure waste.

export default async function PresentProbePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!presentAllowed(user)) redirect("/dashboard");

  return <ProbeClient />;
}
