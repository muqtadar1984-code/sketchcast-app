"use client";

import { useState } from "react";

// "Request activation" on the fair-use meter's school-trial and expired cards
// (0101, Phase 3). One POST to /api/school/request-activation; the server
// stamps the request and emails the founder. Idempotent on the server, so a
// second click (or a second admin) is harmless — the button just says thanks.
export default function RequestActivationButton({
  label,
  done,
  className,
}: {
  label: string;
  done: string;
  className: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function request() {
    setState("busy");
    const res = await fetch("/api/school/request-activation", { method: "POST" });
    setState(res.ok ? "done" : "error");
  }

  if (state === "done") return <span className="text-sm text-[#0C8175]">{done}</span>;
  return (
    <button type="button" onClick={request} disabled={state === "busy"} className={className}>
      {label}
    </button>
  );
}
