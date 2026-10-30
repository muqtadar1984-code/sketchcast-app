"use client";

import { useMemo } from "react";
import SkLauncher from "@/app/dashboard/sk-launcher";
import type { SkShellCopy } from "@/app/dashboard/sk-shell";
import type { WalkCopy } from "@/app/dashboard/sk-walkthrough";
import { createTutorBridge } from "@/sk/shell/client/tutor-bridge";

// SK S3 slice D — the SK Shell on /sk. The /sk layout renders this only when
// skTutorShellEnabledFor() passed; the bridge reads whichever kit player is
// registered when a turn is sent (none on the chapter lists — the tutor moves
// then answer "open a chapter first"). A walkthrough never STARTS on /sk; a
// student's run that reaches SK Tutor carries on here (sessionStorage).
export default function SkTutorLauncher({ copy, walkCopy, role }: { copy: SkShellCopy; walkCopy: WalkCopy; role: string | null }) {
  const tutor = useMemo(() => createTutorBridge(), []);
  return <SkLauncher copy={copy} walkCopy={walkCopy} role={role} hat={null} introDue={false} tutor={tutor} />;
}
