import { requireLibraryMember } from "@/utils/library-access";
import LibraryHeader from "./library-header";

// Library portal shell (library.sketchcast.app). requireLibraryMember() bounces
// everyone else to the portal login (and the whole surface is dark while
// NEXT_PUBLIC_LIBRARY_HOST is unset).
// NOTE: layouts do NOT guard route handlers — every /api/library/* route
// re-checks with isLibraryMemberRequest() itself.
// The portal chrome is staff-facing and stays English, like the console.
export default async function LibraryLayout({ children }: { children: React.ReactNode }) {
  const member = await requireLibraryMember();
  return (
    <div className="min-h-screen bg-[#FBFCFA] text-[#14181F]">
      <LibraryHeader email={member.email} role={member.role} />
      {children}
    </div>
  );
}
