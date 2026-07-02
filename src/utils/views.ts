"use client";

import { createClient } from "@/utils/supabase/client";

// Record that the signed-in teacher opened a generated artifact (video, deck,
// or doc). One row per (teacher, generation, kind) — duplicates are ignored —
// feeding the beta "you've seen everything → give feedback" trigger.
// Fire-and-forget: never blocks or breaks the click it decorates.
export function recordArtifactView(generationId: string, kind: "video_mp4" | "deck_pptx" | "docx"): void {
  const supabase = createClient();
  void supabase.auth.getUser().then(({ data: { user } }) => {
    if (!user) return;
    return supabase
      .from("artifact_views")
      .upsert(
        { teacher_id: user.id, generation_id: generationId, kind },
        { onConflict: "teacher_id,generation_id,kind", ignoreDuplicates: true },
      )
      .then(() => undefined);
  });
}
