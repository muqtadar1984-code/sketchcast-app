// The public pages follow the catalogue.
//
// sketchcast.app/topics is a static site (repo sketchcast-landing) that its own
// GitHub Actions workflow (.github/workflows/topics.yml) rebuilds from
// public_catalogue(): nightly, and whenever we send it a `repository_dispatch`
// — which the library routes do after an action that changes what the public
// catalogue shows (a topic retired, reopened, renamed or merged; a kit
// approved; the question bank's maturity moved). A publish is NOT one of them:
// the route only queues the job and the WORKER makes the video public minutes
// later, so a new lesson still waits for the nightly run (or the worker
// sending the same dispatch — a follow-up).
//
// Best-effort, never throws, DORMANT WITHOUT A TOKEN: with GITHUB_LANDING_TOKEN
// unset every call answers { unconfigured: true } and nothing is sent. Nightly
// covers everything; this only shortens the wait. The autofix token is not
// reused — it is scoped to sketchcast-app, and a token that can write to the
// public marketing repo should be a token that can do nothing else:
//
//   GITHUB_LANDING_TOKEN   fine-grained PAT, repository sketchcast-landing only,
//                          permission Contents: read & write (what
//                          repository_dispatch needs), nothing else. Vercel env
//                          (Production). Rotation = replace the variable.
//
// The payload names the reason and the time and nothing else: sketchcast-landing
// is PUBLIC and a public repo's workflow runs are public, so no id, title or
// member ever travels in it.

const OWNER = process.env.GITHUB_LANDING_OWNER || "muqtadar1984-code";
const REPO = process.env.GITHUB_LANDING_REPO || "sketchcast-landing";
const API = "https://api.github.com";

/** The event name .github/workflows/topics.yml listens for. */
export const LANDING_REBUILD_EVENT = "catalogue-changed";

/** How long a route waits for GitHub before giving up: the member is waiting
 *  on the response, and the nightly run is the fallback anyway. */
export const LANDING_REBUILD_TIMEOUT_MS = 3000;

export type LandingRebuildResult = { ok: boolean; unconfigured?: boolean; status?: number; error?: string };

function token(): string | null {
  const t = process.env.GITHUB_LANDING_TOKEN;
  return t && t.length > 10 ? t : null;
}

export function landingRebuildConfigured(): boolean {
  return token() !== null;
}

/** Ask the landing site to rebuild its /topics pages. Awaited (not fired and
 *  forgotten) so a serverless function does not return before the request has
 *  left; bounded by LANDING_REBUILD_TIMEOUT_MS. A failure is logged and
 *  swallowed: the console action already happened, and the nightly run will
 *  pick the change up regardless. */
export async function requestLandingRebuild(reason: string, fetchImpl: typeof fetch = fetch): Promise<LandingRebuildResult> {
  const t = token();
  if (!t) return { ok: false, unconfigured: true };
  let result: LandingRebuildResult;
  try {
    const res = await fetchImpl(`${API}/repos/${OWNER}/${REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sketchcast-app",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: LANDING_REBUILD_EVENT, client_payload: { reason, at: new Date().toISOString() } }),
      signal: AbortSignal.timeout(LANDING_REBUILD_TIMEOUT_MS),
    });
    // GitHub answers 204 No Content on success.
    result = res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }
  if (!result.ok) console.warn(`[landing] rebuild request (${reason}) not accepted: ${result.status ?? ""} ${result.error ?? ""}`.trim());
  return result;
}
