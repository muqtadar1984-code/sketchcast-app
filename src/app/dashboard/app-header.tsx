import Link from "next/link";
import { LogoMark } from "./icons";
import HeaderNav from "./header-nav";

// Shared app bar for both the teacher and student dashboards.
export default function AppHeader({ name, role }: { name: string; role: string | null }) {
  return (
    <header className="border-b border-[#E6E8E4] bg-gradient-to-b from-[#F5F6F3] to-white">
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <span className="flex items-center gap-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 text-xl font-display">
            <LogoMark size={30} />
            SketchCast <span className="text-[#0C8175]">AI</span>
          </Link>
          {role === "teacher" && <HeaderNav />}
        </span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[#5B6470]">
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
