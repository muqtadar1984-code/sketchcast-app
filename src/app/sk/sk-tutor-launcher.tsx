"use client";

import { useMemo } from "react";
import SkLauncher from "@/app/dashboard/sk-launcher";
import type { SkShellCopy } from "@/app/dashboard/sk-shell";
import type { TourCopy } from "@/tour/definitions";
import { createTutorBridge } from "@/sk/shell/client/tutor-bridge";

// SK S3 slice D — the SK Shell on /sk. The /sk layout renders this only when
// skTutorShellEnabledFor() passed; the bridge reads whichever kit player is
// registered when a turn is sent (none on the chapter lists — the tutor moves
// then answer "open a chapter first"). No §4.6 intro on /sk: the role tour's
// anchors live on the dashboard.
export default function SkTutorLauncher({ copy, tourCopy, role }: { copy: SkShellCopy; tourCopy: TourCopy; role: string | null }) {
  const tutor = useMemo(() => createTutorBridge(), []);
  return <SkLauncher copy={copy} tourCopy={tourCopy} role={role} hat={null} introDue={false} tutor={tutor} />;
}
