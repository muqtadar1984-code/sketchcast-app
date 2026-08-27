"use client";

import { notFound } from "next/navigation";
import ProbeClient from "@/app/present/probe/probe-client";

// The ink-latency harness with the allowlist taken off — DEV ONLY.
//
// The real surface is /present/probe, which requires a signed-in account on the
// Present allowlist. That gate is exactly right in production and exactly wrong
// for checking the harness works: verifying it would otherwise mean holding a
// production login, and a measurement tool that has never been watched running
// is not a measurement tool. Same component, same code path, no gate.
//
// notFound() in production, in the manner of /preview/kit — so this file and its
// import of an ungated harness cannot exist on a deployed build.

export default function BoardProbePreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ProbeClient />;
}
