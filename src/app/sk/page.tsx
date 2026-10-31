import { skRedirect } from "./redirect";

// SK Tutor is retired (founder 2026-10-31): books are taught on the Classroom
// Board. This address only forwards a bookmark (redirect-path.ts).

export const dynamic = "force-dynamic";

export default async function SkIndexPage(): Promise<never> {
  return skRedirect();
}
