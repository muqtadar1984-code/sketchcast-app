"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SLUG_RE, schoolHostname } from "@/utils/school-routing";

// Slug entry box on the portal root. On the school host the public address is
// /{slug}; when the page is opened by its internal path (local dev, no host
// rules) fall back to /school/{slug} so the link still works.
export default function SchoolFinder() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const s = slug.trim().toLowerCase();
    if (!SLUG_RE.test(s)) {
      setError("School codes are lowercase letters, numbers and dashes.");
      return;
    }
    const onPortalHost =
      typeof window !== "undefined" && schoolHostname() === window.location.hostname.toLowerCase();
    router.push(onPortalHost ? `/${s}` : `/school/${s}`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required
        placeholder="e.g. demo"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
        autoCapitalize="none"
        autoCorrect="off"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="btn-primary w-full h-11">
        Go to my school
      </button>
    </form>
  );
}
