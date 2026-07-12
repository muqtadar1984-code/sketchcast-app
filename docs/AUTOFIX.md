# Autofix — automated bug-fix pipeline

Turn a reported issue into a code fix you approve **from email**. You tap "Attempt
auto-fix" on an issue → a GitHub Action (Claude Code) writes the fix on a branch and
opens a PR → you get an email with **Approve / Reject** links → Approve squash-merges
to `main` → Vercel deploys. **Nothing reaches production without your tap.**

## The loop

```
/console/issues/[id]  →  🔧 Attempt auto-fix   (staff only)
  POST /api/autofix/dispatch → autofix_runs row + GitHub repository_dispatch(autofix)
    .github/workflows/autofix.yml → Claude Code writes fix → tsc+eslint+vitest → gh pr create
      POST /api/autofix/pr-opened (shared secret) → email you Approve/Reject signed links
        GET /api/autofix/decide?token=…  → Approve: merge (if CI green) → prod ; Reject: close PR
```

## Safety (built in)

- **PR-only + green-CI gate** — every fix is a branch/PR; `tsc`/`eslint`/`vitest` must pass;
  Approve **refuses to merge a red-CI PR**.
- **Your approval is the only release path** — no auto-merge. The links are HMAC-signed,
  single-use (via `autofix_runs.decided_at`), and expire in 7 days.
- **Kill switch** — `FEATURE_AUTOFIX` off ⇒ every `/api/autofix/*` route 404s and the button hides.
- **Least-privilege GitHub token**, scoped to this one repo.
- **Sensitive-diff flag** — a diff touching `auth/billing/migrations/middleware/stripe/…` is
  flagged "⚠️ sensitive" in the PR + email.
- **PII** — the dispatch to the (public) Action carries only the *user-safe* diagnosis with
  emails/ids scrubbed; you only fire it on issues you've eyeballed.

## One-time setup (to activate)

1. **Migration:** run `supabase/migrations/0039_autofix.sql`.
2. **Enable GitHub Actions** on `muqtadar1984-code/sketchcast-app`.
3. **GitHub token:** create a **fine-grained PAT** scoped to `sketchcast-app` with
   `Contents: Read/Write`, `Pull requests: Read/Write`, `Actions: Read/Write`,
   `Metadata: Read`. (Or a GitHub App installation token.)
4. **Vercel env:**
   ```
   FEATURE_AUTOFIX=true
   NEXT_PUBLIC_FEATURE_AUTOFIX=true
   GITHUB_AUTOFIX_TOKEN=<the fine-grained PAT>
   GITHUB_AUTOFIX_OWNER=muqtadar1984-code
   AUTOFIX_TOKEN_SECRET=<≥16 random chars>          # signs the email links
   AUTOFIX_CALLBACK_SECRET=<random>                 # authenticates the Action's callback
   ```
5. **GitHub repo secrets** (Settings → Secrets → Actions):
   ```
   ANTHROPIC_API_KEY=<your Anthropic key>
   AUTOFIX_CALLBACK_SECRET=<same value as Vercel>
   AUTOFIX_APP_URL=https://app.sketchcast.app
   ```
6. **Confirm the Claude Code Action version** in `.github/workflows/autofix.yml`
   (`anthropics/claude-code-base-action@beta`) against its current README — pin a tag.

Until step 4's `GITHUB_AUTOFIX_TOKEN` is set, "Attempt auto-fix" records a run but the
workflow won't start (the button tells you so). The whole pipeline is dormant with the flag off.

## Files

| Piece | Path |
|---|---|
| Flag | `src/utils/flags.ts` → `autofixEnabled()` |
| Table | `supabase/migrations/0039_autofix.sql` (`autofix_runs`) |
| Signed link token | `src/utils/autofix/token.ts` (+ tests) |
| GitHub REST client | `src/utils/autofix/github.ts` |
| Approval email | `src/utils/autofix/email.ts` |
| Routes | `src/app/api/autofix/{dispatch,pr-opened,decide}/route.ts` |
| Console UI | `src/app/console/issues/[id]/autofix-panel.tsx` |
| Fix workflow | `.github/workflows/autofix.yml` |

## First live smoke test (after setup)

On a throwaway issue in `/console/issues`, tap **Attempt auto-fix** → watch the Action run
(GitHub → Actions) → a PR opens → the email arrives → **Reject** closes it (safe), or
**Approve** merges + Vercel deploys. Then flip `FEATURE_AUTOFIX` off to pause anytime.

## Phase 2 (later)

Auto-trigger on diagnosis-classified code bugs; extend to the worker (`master`) + landing
(`main`); have the agent write the failing test first; a console auto-fix dashboard + metrics.
