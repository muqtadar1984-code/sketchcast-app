import Link from "next/link";
import { LogoMark } from "./icons";

// Shared app bar for both the teacher and student dashboards.
export default function AppHeader({ name, role }: { name: string; role: string | null }) {
  return (
    <header className="border-b border-[#EBE3D3] bg-gradient-to-b from-[#FCFAF4] to-white">
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <span className="flex items-center gap-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 text-xl font-serif">
            <LogoMark size={30} />
            SketchCast <span className="text-[#2E6B4E]">AI</span>
          </Link>
          {role === "teacher" && (
            <nav className="hidden sm:flex items-center gap-4 text-sm">
              <Link href="/dashboard" className="text-[#6F6A5F] hover:text-[#2C2A26]">Library</Link>
              <Link href="/dashboard/analytics" className="text-[#6F6A5F] hover:text-[#2C2A26]">Analytics</Link>
            </nav>
          )}
        </span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[#6F6A5F]">
            {name}
            {role ? ` · ${role}` : ""}
          </span>
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
