// Minimal GitHub REST client for the autofix pipeline — plain fetch, no @octokit
// (matches the repo's SDK-free style, cf. the Resend + Lemon Squeezy clients).
// Uses a least-privilege fine-grained token (GITHUB_AUTOFIX_TOKEN) scoped to the
// sketchcast-app repo with contents/pull_requests/actions write. Every call is
// best-effort and NEVER throws: it returns { ok, unconfigured?, status?, error? }
// so a caller (or a local run with no token) can branch instead of crashing.

const OWNER = process.env.GITHUB_AUTOFIX_OWNER || "muqtadar1984-code";
const REPO = process.env.GITHUB_AUTOFIX_REPO || "sketchcast-app";
const API = "https://api.github.com";

export type GhResult = { ok: boolean; unconfigured?: boolean; status?: number; error?: string };

function token(): string | null {
  const t = process.env.GITHUB_AUTOFIX_TOKEN;
  return t && t.length > 10 ? t : null;
}

async function gh(method: string, path: string, body?: unknown): Promise<GhResult> {
  const t = token();
  if (!t) return { ok: false, unconfigured: true };
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sketchcast-autofix",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function autofixRepoConfigured(): boolean {
  return token() !== null;
}

export const repoSlug = () => `${OWNER}/${REPO}`;

/** Kick off the fix workflow (.github/workflows/autofix.yml, on: repository_dispatch). */
export function repositoryDispatch(eventType: string, payload: Record<string, unknown>): Promise<GhResult> {
  return gh("POST", `/repos/${OWNER}/${REPO}/dispatches`, { event_type: eventType, client_payload: payload });
}

/** Squash-merge an approved PR to the default branch (→ Vercel auto-deploys). */
export function mergePr(prNumber: number, commitTitle?: string): Promise<GhResult> {
  return gh("PUT", `/repos/${OWNER}/${REPO}/pulls/${prNumber}/merge`, {
    merge_method: "squash",
    ...(commitTitle ? { commit_title: commitTitle } : {}),
  });
}

/** Close a rejected PR without merging. */
export function closePr(prNumber: number): Promise<GhResult> {
  return gh("PATCH", `/repos/${OWNER}/${REPO}/pulls/${prNumber}`, { state: "closed" });
}

/** Delete the fix branch after close/merge (best-effort). */
export function deleteBranch(branch: string): Promise<GhResult> {
  return gh("DELETE", `/repos/${OWNER}/${REPO}/git/refs/heads/${encodeURIComponent(branch)}`);
}
