"use client";

import { useSearchParams } from "next/navigation";

// Shows the `?error=` message the /auth/callback route redirects back with
// (cancelled provider consent, bad return, exchange failure). Wrap in <Suspense>
// where used. Renders nothing when there's no error.
export default function AuthError() {
  const err = useSearchParams().get("error");
  if (!err) return null;
  return (
    <p role="alert" className="text-sm text-red-600 mb-4 -mt-2">
      {err}
    </p>
  );
}
