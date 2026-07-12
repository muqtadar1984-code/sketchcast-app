# SketchCast portal — front-end QA test plan (living catalog)

> The single source of truth for what the **qa-frontend** agent tests. Generated from a
> feature-by-feature code sweep and refreshed when features change. **202 scenarios**
> across 13 areas. Edit freely — add scenarios, tighten steps, re-prioritize.

## How to use this

- **Agent:** `.claude/agents/qa-frontend.md` — invoke via the Agent tool with
  `subagent_type: "qa-frontend"`. Tell it the **TARGET** (`prod` or `local`) and a scope
  (`smoke`, `area:<name>`, or specific ids). Default = the P0 smoke set + cross-cutting.
- **Targets:** `prod` → `https://app.sketchcast.app` (landing/pricing `https://sketchcast.app`);
  `local` → `http://localhost:3000` (`preview_start({name:"web"})`).
- **Release rule:** nothing ships to prod until it passes on **local** first. A prod run is a
  smoke confirmation, not a substitute for the local pass. The agent refuses to bless a
  release with any open P0/P1 FAIL.

## Flag legend

| Flag | Meaning |
|---|---|
| 🔒 | **requires_login** — needs an authenticated session (human signs in first). |
| 🔑 | **requires_secret** — needs typing a password / payment / token, or creating an account. The agent must NOT do this; it hands the step to the human. |
| ⚠️ | **destructive** — ends in an irreversible confirm (delete/send/publish/purchase/suspend). The agent verifies the control is wired but does NOT fire it unless explicitly authorized for that run. |

The agent's hard safety boundary means 🔑 and ⚠️ steps are **human-driven**. Everything else
it runs autonomously (a human-authenticated session is fine and expected for 🔒).

## P0 smoke set — must pass on every deploy

| id | flags | role | title |
|---|---|---|---|
| `auth-onboarding-01` | 🔑 | teacher | Teacher signs in with email + password (happy path) |
| `auth-onboarding-05` | 🔒 | teacher | Un-onboarded adult is force-redirected from /dashboard to /onboarding |
| `auth-onboarding-14` | 🔒 | teacher | Reset-password scope guard blocks a student not taught by the caller (no cross-tenant reset) |
| `library-authoring-01-login-smoke` | 🔑 | teacher | Teacher logs in and lands on the Library |
| `library-authoring-02-unauth-redirect` | — | anon | Signed-out visit to the Library redirects to login |
| `library-authoring-04-upload-index-book` | 🔒 | teacher | Upload a textbook PDF and see it index into chapters |
| `library-authoring-05-generate-lesson` | 🔒 | teacher | Generate a narrated lesson (presentation) for a chapter |
| `classes-students-01` | 🔒 | teacher | Teacher creates a class |
| `classes-students-06` | 🔒 | teacher | Assign a generated lesson/chapter to a class |
| `student-dashboard-assigned-05` | 🔒 | student | Student sees only the lessons assigned to them, grouped by class and chapter |
| `student-watch-complete-07` | 🔒 | student | Watching a lesson to the end marks it complete |
| `student-auth-guard-15` | — | anon | Signed-out visitor cannot reach the student dashboard |
| `nav-chrome-a11y-01` | 🔒 | teacher | Teacher header shows exactly Library + My Analytics and the 'teacher' label |
| `nav-chrome-a11y-05` | 🔒 | any | Sign out from the header ends the session and blocks protected routes |
| `ai-assistant-launcher-visible-01` | 🔒 | any | Floating Assistant launcher appears on every dashboard page for a logged-in user |
| `console-admin-02` | 🔒 | teacher | Non-staff user is bounced from the console to /dashboard |
| `billing-status-adult-gated` | 🔒 | teacher | Adult billing status reflects the BILLING_ENABLED gate |

## Cross-cutting checks — run on every page

| id | check | expected |
|---|---|---|
| `cc-01-console-clean` | No uncaught JS / console errors on load or interaction | Every route loads and is exercised with zero error-level console entries (uncaught exceptions, React hydration errors, failed prop types). Warnings are triaged but must not include errors. |
| `cc-02-network-health` | No unexpected failed network requests | All XHR/fetch/document requests return 2xx, or a 3xx redirect, except deliberate guard responses (401/403/404 on protected APIs). No 5xx, no CORS failures, no requests stuck pending past a sane timeout. |
| `cc-03-broken-links-404` | No broken internal links; unknown route renders branded 404 | Every nav tab, header link, and in-page CTA resolves to a 200 page; an unknown route renders the app's 404 with chrome intact and a way back home (aligns with nav-chrome-a11y-16). |
| `cc-04-responsive-mobile` | Responsive layout at mobile width (375px) | No horizontal body scroll; nav collapses per nav-chrome-a11y-11; text, tables and modals reflow; tap targets remain usable; the Assistant launcher does not obscure primary actions. |
| `cc-05-dark-light-theme` | Dark and light modes both render correctly | Both themes render with no invisible/low-contrast text, no unstyled flashes, and correct console dark chrome; theme toggle (or system preference) is honored on every surface. |
| `cc-06-a11y-landmarks` | Accessibility landmarks, headings, and focus | Each page exposes proper landmarks, a single logical h1, aria-current on the active tab (nav-chrome-a11y-04), keyboard focus order and visible focus rings, labelled form controls, and alt text on meaningful images. |
| `cc-07-security-headers-no-secret-leak` | Security headers present and no secrets exposed | Responses carry CSP, HSTS, X-Frame-Options/anti-clickjacking, and nosniff. No API keys, tokens, service-role secrets, or PII appear in HTML source, bundled JS, or URL query strings. |
| `cc-08-cross-tenant-isolation` | No cross-tenant / cross-role data leakage on any surface | Every list, detail page, search, and API response is scoped to the caller's tenant, school slice, and role; RLS holds even on direct API calls with a valid session for a different tenant's ids (reinforces library-13, classes-04, ai-assistant-16, analytics-11, support-12). |
| `cc-09-auth-guard-protected-routes` | Protected routes and APIs enforce auth when signed out | Signed-out access to any /dashboard, /console, or portal route redirects to /login; corresponding APIs return 401/404 (not 200 and not a probeable 403 for console) and never render partial protected content before redirect. |
| `cc-10-loading-empty-error-states` | Graceful loading, empty, and error states | No infinite spinners, no raw stack traces or provider error dumps surfaced to users; slow generation/index jobs show progress; empty datasets show the intended empty state rather than a broken layout. |

## Recommended run order (full pass)

1. **Auth & onboarding** (`auth-onboarding`)
2. **Nav, chrome & accessibility** (`nav-chrome-a11y`)
3. **Library & authoring (generate)** (`library-authoring`)
4. **Classes & students** (`classes-students`)
5. **student** (`student`)
6. **Parent portal** (`parent-portal`)
7. **AI Teaching Assistant** (`ai-assistant`)
8. **AI Tutor / Ask Coach / TAL board** (`ai-tutor-tal`)
9. **Analytics & school oversight** (`analytics-school`)
10. **Platform console (admin)** (`console-admin`)
11. **Billing (Stripe + Lemon Squeezy)** (`billing`)
12. **support** (`support`)
13. **tour** (`tour`)

## Human-required scenarios (session / secret / destructive)

These need you to sign in, type a secret, create an account, or authorize an irreversible
action. The agent will pause and mark them `BLOCKED (needs human)`.

| id | flags | title |
|---|---|---|
| `auth-onboarding-01` | 🔑 | Teacher signs in with email + password (happy path) |
| `auth-onboarding-03` | 🔑 | Student logs in with student ID (no @) mapped to synthetic email |
| `auth-onboarding-04` | 🔑 | Teacher email signup creates account and shows confirm-email notice |
| `auth-onboarding-08` | ⚠️ | Forgot-password sends a reset link with a non-enumerating message |
| `auth-onboarding-11` | 🔑 | Forced password change: must_reset_password funnels to update-password and clears on set |
| `auth-onboarding-12` | 🔒🔑 | Update-password rejects short or mismatched passwords |
| `auth-onboarding-13` | 🔒⚠️ | Teacher resets their own student's password and sees the temp password once |
| `auth-onboarding-15` | 🔒⚠️ | Invite acceptance elevates role for a matching signed-in email |
| `auth-onboarding-17` | 🔑 | Set-up-your-school flow creates a new school and makes the user its admin |
| `library-authoring-01-login-smoke` | 🔑 | Teacher logs in and lands on the Library |
| `library-authoring-09-regenerate-lesson` | 🔒⚠️ | Regenerate a chapter lesson replaces the old deck/video |
| `library-authoring-10-delete-lesson` | 🔒⚠️ | Delete a single lesson/document from a chapter |
| `library-authoring-11-delete-book` | 🔒⚠️ | Delete a whole book from the library |
| `classes-students-03` | 🔒🔑 | Provision students and hand out login credentials |
| `classes-students-05` | 🔑 | Student first sign-in with ID is forced through password reset |
| `classes-students-09` | 🔒⚠️ | Reset a student's password from the roster |
| `student-login-username-01` | 🔑 | Student signs in with their student ID (no email) |
| `student-first-run-reset-02` | 🔑 | Freshly provisioned student is forced to set a password on first sign-in |
| `parent-portal-signup-01` | 🔑 | Self-serve parent signup exposes and creates a Parent account |
| `parent-portal-invite-accept-13` | 🔑 | Invitee accepts a school parent invite and is linked to the child |
| `analytics-school-12` | 🔒⚠️ | Admin resets a member's password from the roster and gets a one-time temp password |
| `console-admin-01` | 🔒🔑 | Platform staff signs in and lands on the console Overview |
| `console-admin-08` | 🔒⚠️ | Suspend then unsuspend a non-staff account (login ban + data cutoff) |
| `console-admin-12` | 🔒⚠️ | Content takedown hides a book from its owner (RLS), then restore returns it |
| `billing-checkout-school-happy` | 🔒🔑⚠️ | School admin gets a Stripe (MYR) hosted checkout URL |
| `billing-checkout-teacher-ls-happy` | 🔒🔑⚠️ | Teacher plan routes to Lemon Squeezy (or clean 503 if unconfigured) |
| `billing-ls-claim-on-signin` | 🔒🔑 | Public-pricing-page purchase is claimed on first authenticated status read |
| `support-report-problem-adult-01` | 🔒⚠️ | Adult files a tech-issue report via the bottom-left widget |
| `support-report-problem-student-minimized-02` | 🔒⚠️ | Student help widget is data-minimized (no free-text details) |
| `support-beta-feedback-submit-05` | 🔒⚠️ | Beta teacher submits the 4-star beta feedback form |
| `support-content-diagnose-09` | 🔒⚠️ | Per-lesson 'Report an issue' triggers live AI diagnosis |

---

## Scenarios by area

### Auth & onboarding  `auth-onboarding` — 18 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `auth-onboarding-01` | P0 | 🔑 | teacher | `/login` | Teacher signs in with email + password (happy path) |
| `auth-onboarding-02` | P1 | — | any | `/login` | Login with wrong password is rejected and stays on /login |
| `auth-onboarding-03` | P1 | 🔑 | student | `/login` | Student logs in with student ID (no @) mapped to synthetic email |
| `auth-onboarding-04` | P0 | 🔑 | anon | `/signup` | Teacher email signup creates account and shows confirm-email notice |
| `auth-onboarding-05` | P0 | 🔒 | teacher | `/dashboard` | Un-onboarded adult is force-redirected from /dashboard to /onboarding |
| `auth-onboarding-06` | P0 | 🔒 | teacher | `/onboarding` | Onboarding teacher path: Continue gated until required fields filled, then completes |
| `auth-onboarding-07` | P1 | 🔒 | parent | `/onboarding` | Onboarding parent path lands on /dashboard/children |
| `auth-onboarding-08` | P1 | ⚠️ | any | `/login/forgot` | Forgot-password sends a reset link with a non-enumerating message |
| `auth-onboarding-09` | P2 | — | student | `/login/forgot` | Forgot-password shows student-ID hint and sends no email |
| `auth-onboarding-10` | P2 | — | anon | `/auth/update-password` | Update-password page with no session shows expired/not-signed-in state |
| `auth-onboarding-11` | P0 | 🔑 | student | `/dashboard` | Forced password change: must_reset_password funnels to update-password and clears on set |
| `auth-onboarding-12` | P1 | 🔒🔑 | any | `/auth/update-password` | Update-password rejects short or mismatched passwords |
| `auth-onboarding-13` | P1 | 🔒⚠️ | teacher | `/dashboard` | Teacher resets their own student's password and sees the temp password once |
| `auth-onboarding-14` | P0 | 🔒 | teacher | `/dashboard` | Reset-password scope guard blocks a student not taught by the caller (no cross-tenant reset) |
| `auth-onboarding-15` | P1 | 🔒⚠️ | teacher | `/invite` | Invite acceptance elevates role for a matching signed-in email |
| `auth-onboarding-16` | P0 | — | any | `/invite` | Invite guards: invalid, expired, already-used, and wrong-email are all blocked |
| `auth-onboarding-17` | P1 | 🔑 | anon | `/schoolsignup` | Set-up-your-school flow creates a new school and makes the user its admin |
| `auth-onboarding-18` | P1 | 🔒 | any | `/dashboard` | Sign out returns to /login and blocks dashboard access |

<details><summary>Detailed steps & expected</summary>

**`auth-onboarding-01` — Teacher signs in with email + password (happy path)** _(P0, teacher)_
- _Pre:_ An existing, confirmed, already-onboarded teacher account (email + password) provided by the human tester.
- _Steps:_
  1. Open /login
  1. Type the teacher's email into the 'Email or student ID' field
  1. Type the teacher's password into the password field (HUMAN enters this)
  1. Click 'Sign in'
- _Expect:_ Session is established and the browser lands on /dashboard showing the teacher's library/home; no error text appears on /login.

**`auth-onboarding-02` — Login with wrong password is rejected and stays on /login** _(P1, any)_
- _Pre:_ A known-existing account email; use a deliberately wrong throwaway password.
- _Steps:_
  1. Open /login
  1. Type a valid account email
  1. Type an obviously wrong password (e.g. 'not-the-real-pw')
  1. Click 'Sign in'
- _Expect:_ An inline red error (Supabase 'Invalid login credentials') appears and the user remains on /login, not redirected to /dashboard.

**`auth-onboarding-03` — Student logs in with student ID (no @) mapped to synthetic email** _(P1, student)_
- _Pre:_ A provisioned student whose login is an ID without '@' plus its password, provided by the human tester.
- _Steps:_
  1. Open /login
  1. Type the bare student ID (no '@') into the 'Email or student ID' field
  1. Type the student's password (HUMAN enters this)
  1. Click 'Sign in'
- _Expect:_ The ID is transformed to the synthetic @students.sketchcast.app address, sign-in succeeds, and the student lands on their student dashboard (not a teacher/parent surface).

**`auth-onboarding-04` — Teacher email signup creates account and shows confirm-email notice** _(P0, anon)_
- _Pre:_ A fresh, unused email the human tester controls (account CREATION must be done by the human).
- _Steps:_
  1. Open /signup
  1. Confirm the role toggle defaults to 'Teacher' and that 'Student' is present (and 'Parent' only if NEXT_PUBLIC_FEATURE_PARENT_PORTAL is on)
  1. Type full name, a fresh email, and a >=6-char password (HUMAN completes and submits this account creation)
  1. Click 'Create account'
- _Expect:_ Either a green 'Check your email to confirm your account' notice appears (email-confirmation ON), or a session is created and the browser goes to /dashboard (confirmation OFF). No red error on valid input.

**`auth-onboarding-05` — Un-onboarded adult is force-redirected from /dashboard to /onboarding** _(P0, teacher, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ A signed-in adult (self-signup) whose profile has onboarded_at = NULL and role != student. FEATURE_ONBOARDING must be ON.
- _Steps:_
  1. While signed in as the un-onboarded adult, navigate to /dashboard
  1. Observe the URL after the server layout runs
- _Expect:_ The dashboard layout gate redirects to /onboarding (the 'Welcome — let's set you up' screen) instead of showing the dashboard; the user cannot reach app surfaces until onboarding completes.

**`auth-onboarding-06` — Onboarding teacher path: Continue gated until required fields filled, then completes** _(P0, teacher, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ Signed-in adult with onboarded_at = NULL. FEATURE_ONBOARDING ON.
- _Steps:_
  1. Land on /onboarding (seeded to Teacher)
  1. With fields empty, click 'Continue' and confirm it does not submit and shows the 'complete the required fields marked with *' hint
  1. Pick 'I teach at a school' and verify a required 'School name' input appears
  1. Fill full name + school name, select at least one grade level and one subject
  1. Click 'Continue'
- _Expect:_ Continue is disabled/blocked until full name + affiliation (+ school name when 'school') + >=1 grade + >=1 subject are set; on completion POST /api/onboarding succeeds and the browser lands on /dashboard as an onboarded teacher (gate no longer fires on return).

**`auth-onboarding-07` — Onboarding parent path lands on /dashboard/children** _(P1, parent, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ Signed-in adult with onboarded_at = NULL. FEATURE_ONBOARDING ON (and parent surfaces available).
- _Steps:_
  1. On /onboarding, switch the role toggle from Teacher to 'Parent'
  1. Confirm the form swaps to parent fields (children count + children's grade levels) and teacher-only fields disappear
  1. Enter a children count (1–20), pick at least one child grade level, fill full name
  1. Click 'Continue'
- _Expect:_ Submission succeeds and the browser is routed to /dashboard/children (homeForRole('parent')); the profile role is now parent, not the silent teacher default.

**`auth-onboarding-08` — Forgot-password sends a reset link with a non-enumerating message** _(P1, any)_
- _Pre:_ An adult account email that the human tester can check for the reset email.
- _Steps:_
  1. Open /login/forgot (or click 'Forgot password?' on /login)
  1. Type a real adult account email
  1. Click 'Send reset link'
- _Expect:_ The form is replaced by 'If an account exists for that email, a reset link is on its way' (identical wording regardless of whether the address exists) and a recovery email is actually dispatched to a real inbox.

**`auth-onboarding-09` — Forgot-password shows student-ID hint and sends no email** _(P2, student)_
- _Pre:_ None.
- _Steps:_
  1. Open /login/forgot
  1. Type a value with no '@' (e.g. a student ID like 'jsmith12')
  1. Click 'Send reset link'
- _Expect:_ An amber hint appears telling the student to ask their teacher or parent to reset from their dashboard; no request is sent and the success message is NOT shown.

**`auth-onboarding-10` — Update-password page with no session shows expired/not-signed-in state** _(P2, anon)_
- _Pre:_ No active session (signed out / fresh browser).
- _Steps:_
  1. While signed out, navigate directly to /auth/update-password
  1. Wait for the session check to resolve
- _Expect:_ Instead of the password form, an amber 'This link has expired or you're not signed in' box appears with links to request a new reset link or sign in; no password fields are usable.

**`auth-onboarding-11` — Forced password change: must_reset_password funnels to update-password and clears on set** _(P0, student)_
- _Pre:_ An account with profiles.must_reset_password = true and its temporary password (e.g. one just handed out via a reset). Human enters both the temp and new passwords.
- _Steps:_
  1. Sign in with the temporary password (HUMAN enters it)
  1. Observe the redirect off /dashboard
  1. On /auth/update-password, type a new password (min 8) twice — matching (HUMAN enters)
  1. Click 'Set new password'
- _Expect:_ Dashboard immediately redirects to /auth/update-password; after setting a valid matching >=8-char password the must_reset_password flag clears and the user is taken to /dashboard without being bounced back.

**`auth-onboarding-12` — Update-password rejects short or mismatched passwords** _(P1, any)_
- _Pre:_ A valid recovery/must-reset session on the update-password page (set up by the human).
- _Steps:_
  1. On /auth/update-password with an active session, type a 5-char password in both fields and submit
  1. Then type two different >=8-char passwords and submit
- _Expect:_ First submit shows 'Password must be at least 8 characters.'; second shows 'The two passwords don't match.'; neither navigates away until a valid matching password is entered.

**`auth-onboarding-13` — Teacher resets their own student's password and sees the temp password once** _(P1, teacher)_
- _Pre:_ Signed in as a teacher who owns a class with at least one enrolled student.
- _Steps:_
  1. On the teacher dashboard, find the student on the class roster
  1. Click 'Reset password'
  1. Click 'Yes, reset' on the inline confirm
- _Expect:_ POST /api/reset-password succeeds (via='teacher'); a one-time temporary password is displayed inline with a Copy button and a '(shown once)' note; the student's must_reset_password is set so their next sign-in forces a change.

**`auth-onboarding-14` — Reset-password scope guard blocks a student not taught by the caller (no cross-tenant reset)** _(P0, teacher)_
- _Pre:_ Signed in as a teacher; obtain the profile id of a student in a DIFFERENT class/school (not enrolled with this teacher).
- _Steps:_
  1. Trigger POST /api/reset-password with targetId set to a student the caller does not teach (e.g. via a reset button on a roster the teacher shouldn't be able to act on, or a crafted request)
  1. Observe the response/UI
- _Expect:_ The request is denied with a 403 'You can't reset this account's password.' (decideReset finds no relationship); no temporary password is issued and the target's password is unchanged.

**`auth-onboarding-15` — Invite acceptance elevates role for a matching signed-in email** _(P1, teacher)_
- _Pre:_ A valid, unexpired, unused invite (e.g. teacher or school_admin role) AND being signed in as the exact invited email. Human sets up the invite + account.
- _Steps:_
  1. Open /invite/<token> while signed in as the invited email
  1. Confirm the card shows the school name and invited role and that the 'Accept invitation' button is offered (email matches)
  1. Click 'Accept invitation'
- _Expect:_ The /invite/<token>/accept route applies role + school_id via the service role, marks the invite accepted_at (one-time use consumed), stamps onboarded_at, and redirects to /dashboard (or /dashboard/children for a parent invite).

**`auth-onboarding-16` — Invite guards: invalid, expired, already-used, and wrong-email are all blocked** _(P0, any)_
- _Pre:_ Have four token states available from the human: a garbage/invalid token, an expired invite, an already-accepted invite, and a valid invite opened while signed in as a DIFFERENT email.
- _Steps:_
  1. Open /invite/<garbage-token> and read the message
  1. Open an expired invite link and read the message
  1. Open an already-used invite link and read the message
  1. Open a valid invite while signed in as a non-matching email and attempt to proceed
- _Expect:_ Invalid → 'This invitation link is invalid.'; expired → 'This invitation has expired.'; used → 'This invitation has already been used.'; email mismatch → the client shows the signed-in-as-wrong-email notice with a Sign out option and no Accept button (and the accept route would redirect back with e=email). No role elevation occurs in any case.

**`auth-onboarding-17` — Set-up-your-school flow creates a new school and makes the user its admin** _(P1, anon)_
- _Pre:_ A fresh email the human controls (account CREATION done by the human). Confirmation may need email verification.
- _Steps:_
  1. Open /schoolsignup
  1. HUMAN creates the account (full name, work email, >=6-char password) and clicks 'Continue'
  1. On /schoolsignup/finish (signed-in), type a school name (>=2 chars)
  1. Click 'Create my school'
- _Expect:_ POST /api/school-finish creates a new empty school, sets the caller's role to school_admin with the new school_id and stamps onboarded_at (so the onboarding gate is skipped), then redirects to /dashboard as the school admin.

**`auth-onboarding-18` — Sign out returns to /login and blocks dashboard access** _(P1, any)_
- _Pre:_ Any signed-in account.
- _Steps:_
  1. From a signed-in dashboard, trigger Sign out (POST /auth/signout)
  1. After landing on /login, navigate directly to /dashboard
- _Expect:_ Sign out clears the session and redirects (303) to /login; a subsequent direct visit to /dashboard redirects back to /login because there is no session.

</details>

### Nav, chrome & accessibility  `nav-chrome-a11y` — 16 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `nav-chrome-a11y-01` | P0 | 🔒 | teacher | `/dashboard` | Teacher header shows exactly Library + My Analytics and the 'teacher' label |
| `nav-chrome-a11y-02` | P0 | 🔒 | student | `/dashboard` | Student header shows no nav tabs and the 'student' label |
| `nav-chrome-a11y-03` | P0 | 🔒 | school_admin | `/dashboard` | School admin sees the full leadership nav and 'admin & teacher' label |
| `nav-chrome-a11y-04` | P0 | 🔒 | teacher | `/dashboard/analytics` | Active tab underline and aria-current track the current route |
| `nav-chrome-a11y-05` | P0 | 🔒 | any | `/dashboard` | Sign out from the header ends the session and blocks protected routes |
| `nav-chrome-a11y-06` | P0 | 🔒 | teacher | `/onboarding` | Un-onboarded adult is gated to /onboarding before any dashboard chrome |
| `nav-chrome-a11y-07` | P0 | 🔒 | teacher | `/console` | Non-staff cannot reach the /console chrome (bounced to dashboard) |
| `nav-chrome-a11y-08` | P1 | 🔒 | coordinator | `/dashboard` | Coordinator with scope sees School/Teachers/Access but not Admin, label 'teacher & coordinator' |
| `nav-chrome-a11y-09` | P1 | 🔒 | parent | `/dashboard` | Parent sees My Children + Test Papers tabs and the 'parent' label |
| `nav-chrome-a11y-10` | P1 | 🔒 | teacher | `/dashboard` | Teacher who is also a parent gets the union of tabs and combined 'teacher & parent' label |
| `nav-chrome-a11y-11` | P1 | 🔒 | teacher | `/dashboard` | Responsive: nav tabs collapse (hidden) on a mobile viewport |
| `nav-chrome-a11y-12` | P1 | 🔒 | platform_admin | `/console` | Console dark chrome: staff tabs, active underline, email · staff, and '← App' back link |
| `nav-chrome-a11y-13` | P1 | 🔒 | coordinator | `/dashboard/school/admin` | Guard: coordinator/teacher blocked from the Admin surface |
| `nav-chrome-a11y-14` | P2 | 🔒 | school_admin | `/dashboard/school/admin` | Active-tab edge: parent 'School' tab is not underlined while on the Admin child route |
| `nav-chrome-a11y-15` | P2 | 🔒 | any | `/dashboard` | Document title/meta and logo-home affordance |
| `nav-chrome-a11y-16` | P2 | 🔒 | any | `/dashboard/this-route-does-not-exist` | Unknown route renders a 404 without breaking chrome |

<details><summary>Detailed steps & expected</summary>

**`nav-chrome-a11y-01` — Teacher header shows exactly Library + My Analytics and the 'teacher' label** _(P0, teacher)_
- _Pre:_ Signed in as a plain teacher (no coordinator scope, no linked children).
- _Steps:_
  1. Log in as a teacher and land on /dashboard
  1. Inspect the top app header nav
  1. Read the account label to the right of the name
- _Expect:_ The header nav shows only two tabs, 'Library' and 'My Analytics'. No School/Teachers/Access/Admin/Invites/My Children/Test Papers tabs appear. The name is followed by ' · teacher'. A 'Sign out' button and (if tour flag on) 'Tour' button are visible.

**`nav-chrome-a11y-02` — Student header shows no nav tabs and the 'student' label** _(P0, student)_
- _Pre:_ Signed in as a student account.
- _Steps:_
  1. Log in as a student and land on the 'My lessons' dashboard
  1. Inspect the top app header
- _Expect:_ The header renders the SketchCast logo, the name followed by ' · student', and a 'Sign out' button, but NO navigation tabs at all (students never gain adult nav). The logo still links back to /dashboard.

**`nav-chrome-a11y-03` — School admin sees the full leadership nav and 'admin & teacher' label** _(P0, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ Signed in as a school_admin; FEATURE_SCHOOL_ANALYTICS on.
- _Steps:_
  1. Log in as a school admin and land on /dashboard
  1. Inspect every tab in the header nav
  1. Read the account label
- _Expect:_ Nav shows Library, My Analytics, School, Teachers, Access, Admin, and Invites (in that order). The label reads ' · admin & teacher'. Each tab is a working link to its route.

**`nav-chrome-a11y-04` — Active tab underline and aria-current track the current route** _(P0, teacher)_
- _Pre:_ Signed in as any adult with at least two nav tabs.
- _Steps:_
  1. Start on /dashboard; confirm 'Library' is the active (ink-underlined) tab
  1. Click 'My Analytics'
  1. Observe which tab now carries the ink underline and aria-current
- _Expect:_ On /dashboard the 'Library' tab is bold with the drawn ink underline and aria-current='page'; after clicking 'My Analytics' the underline and aria-current='page' move to 'My Analytics' and 'Library' returns to the muted style.

**`nav-chrome-a11y-05` — Sign out from the header ends the session and blocks protected routes** _(P0, any)_
- _Pre:_ Signed in as any role.
- _Steps:_
  1. Click the 'Sign out' button in the app header
  1. After the redirect, attempt to navigate directly to /dashboard
- _Expect:_ The POST to /auth/signout clears the session and the browser lands on the login page; re-requesting /dashboard while signed out redirects back to /login instead of rendering the header.

**`nav-chrome-a11y-06` — Un-onboarded adult is gated to /onboarding before any dashboard chrome** _(P0, teacher, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ Signed-in self-signup adult whose profile has onboarded_at = NULL and role != student; FEATURE_ONBOARDING on.
- _Steps:_
  1. As the un-onboarded adult, navigate to /dashboard
  1. Observe the resulting URL and page
- _Expect:_ The dashboard layout redirects to /onboarding and the Teacher/Parent confirmation form renders; the normal app header nav is NOT shown until onboarding completes. A student account in the same state is NOT redirected here.

**`nav-chrome-a11y-07` — Non-staff cannot reach the /console chrome (bounced to dashboard)** _(P0, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a non-staff user (teacher/parent); FEATURE_PLATFORM_CONSOLE on.
- _Steps:_
  1. While signed in as a non-staff user, navigate directly to /console
  1. Observe the resulting URL and header
- _Expect:_ requirePlatformAdmin redirects to /dashboard (indistinguishable from a missing page); the dark Console header never renders and no staff tabs are exposed.

**`nav-chrome-a11y-08` — Coordinator with scope sees School/Teachers/Access but not Admin, label 'teacher & coordinator'** _(P1, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ Signed in as a user holding a coordinator_scope grant; FEATURE_SCHOOL_ANALYTICS on.
- _Steps:_
  1. Log in as a scoped coordinator and land on /dashboard
  1. Inspect the header nav tabs and the account label
- _Expect:_ Nav shows Library, My Analytics, School, Teachers, Access — but NOT Admin and NOT Invites (those are school_admin-only). Label reads ' · teacher & coordinator'.

**`nav-chrome-a11y-09` — Parent sees My Children + Test Papers tabs and the 'parent' label** _(P1, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Signed in as a parent with at least one parent_links child row; FEATURE_PARENT_PORTAL on.
- _Steps:_
  1. Log in as a parent and land on /dashboard
  1. Inspect the header nav and the account label
- _Expect:_ Nav shows Library, My Analytics, My Children, and Test Papers. Label reads ' · parent'. School/Admin/Invites tabs are absent.

**`nav-chrome-a11y-10` — Teacher who is also a parent gets the union of tabs and combined 'teacher & parent' label** _(P1, teacher, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Signed in as a teacher who also has a parent_links child row; FEATURE_PARENT_PORTAL on.
- _Steps:_
  1. Log in as the teacher-and-parent user
  1. Inspect the header nav tabs and the account label
- _Expect:_ Nav shows the union: Library, My Analytics, My Children, Test Papers. The label combines both capabilities as ' · teacher & parent'.

**`nav-chrome-a11y-11` — Responsive: nav tabs collapse (hidden) on a mobile viewport** _(P1, teacher)_
- _Pre:_ Signed in as any adult with nav tabs.
- _Steps:_
  1. Load /dashboard at desktop width and confirm the nav tabs are visible
  1. Resize the viewport to mobile width (~375px)
  1. Re-inspect the header
- _Expect:_ At <640px the nav row (hidden sm:flex) is not displayed, while the logo, name/label, and 'Sign out' control remain visible and the page body does not scroll horizontally.

**`nav-chrome-a11y-12` — Console dark chrome: staff tabs, active underline, email · staff, and '← App' back link** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a founder/allowlisted staff account; FEATURE_PLATFORM_CONSOLE on.
- _Steps:_
  1. As a staff user navigate to /console
  1. Confirm the header is the dark band and lists the staff tabs
  1. Click 'Issues' and observe the active underline move
  1. Click the '← App' link
- _Expect:_ The distinct dark (#14181F) Console header shows Overview/Issues/Users/Schools/Content/Feedback/Audit; the current tab is underlined with aria-current='page' and moves to 'Issues' on click; the header shows the staff email followed by ' · staff'; '← App' returns to /dashboard.

**`nav-chrome-a11y-13` — Guard: coordinator/teacher blocked from the Admin surface** _(P1, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ Signed in as a scoped coordinator (who has no Admin tab); FEATURE_SCHOOL_ANALYTICS on.
- _Steps:_
  1. As the coordinator, navigate directly to /dashboard/school/admin
  1. Observe the resulting URL
- _Expect:_ The coordinator is redirected to /dashboard/school (and a plain teacher hitting the same URL is redirected to /dashboard); the admin-only page never renders for non-admins, matching the fact that no Admin tab is shown to them.

**`nav-chrome-a11y-14` — Active-tab edge: parent 'School' tab is not underlined while on the Admin child route** _(P2, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ Signed in as school_admin; FEATURE_SCHOOL_ANALYTICS on.
- _Steps:_
  1. Navigate to /dashboard/school/admin
  1. Inspect which nav tab carries the ink underline / aria-current
- _Expect:_ Only the 'Admin' tab is active (underlined, aria-current='page'); the 'School' parent tab is NOT underlined even though /dashboard/school is a prefix of the current path.

**`nav-chrome-a11y-15` — Document title/meta and logo-home affordance** _(P2, any)_
- _Pre:_ Signed in as any role.
- _Steps:_
  1. Load /dashboard and read the browser tab title
  1. Navigate to a sub-route (e.g. /dashboard/analytics)
  1. Click the SketchCast logo in the header
- _Expect:_ The browser tab title reads 'SketchCast AI' (from the root metadata) and the document lang is 'en'; clicking the logo from any sub-route returns to /dashboard.

**`nav-chrome-a11y-16` — Unknown route renders a 404 without breaking chrome** _(P2, any)_
- _Pre:_ Signed in as any role.
- _Steps:_
  1. Navigate to a nonexistent path such as /dashboard/this-route-does-not-exist
  1. Observe the rendered page and console
- _Expect:_ A 404 / 'page not found' response renders (Next.js default not-found) rather than a server error or blank crash; the app remains navigable back to /dashboard.

</details>

### Library & authoring (generate)  `library-authoring` — 16 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `library-authoring-01-login-smoke` | P0 | 🔑 | teacher | `/login` | Teacher logs in and lands on the Library |
| `library-authoring-02-unauth-redirect` | P0 | — | anon | `/dashboard` | Signed-out visit to the Library redirects to login |
| `library-authoring-03-onboarding-gate` | P0 | 🔒 | teacher | `/dashboard` | Un-onboarded adult is blocked at the onboarding gate before authoring |
| `library-authoring-04-upload-index-book` | P0 | 🔒 | teacher | `/dashboard` | Upload a textbook PDF and see it index into chapters |
| `library-authoring-05-generate-lesson` | P0 | 🔒 | teacher | `/dashboard` | Generate a narrated lesson (presentation) for a chapter |
| `library-authoring-06-student-blocked-from-authoring` | P0 | 🔒 | student | `/dashboard` | Student on /dashboard sees assignments only, never authoring controls |
| `library-authoring-07-generate-document-kinds` | P1 | 🔒 | teacher | `/dashboard` | Batch-generate worksheet, exam, plan, activity and case study for a chapter |
| `library-authoring-08-download-artifacts` | P1 | 🔒 | teacher | `/dashboard` | Open and download generated artifacts via signed URLs |
| `library-authoring-09-regenerate-lesson` | P1 | 🔒⚠️ | teacher | `/dashboard` | Regenerate a chapter lesson replaces the old deck/video |
| `library-authoring-10-delete-lesson` | P1 | 🔒⚠️ | teacher | `/dashboard` | Delete a single lesson/document from a chapter |
| `library-authoring-11-delete-book` | P1 | 🔒⚠️ | teacher | `/dashboard` | Delete a whole book from the library |
| `library-authoring-12-branding-templates` | P1 | 🔒 | teacher | `/dashboard` | Upload school Word and PowerPoint branding templates |
| `library-authoring-13-cross-tenant-isolation` | P1 | 🔒 | teacher | `/dashboard` | Teacher cannot see another owner's books or artifacts |
| `library-authoring-14-book-health-badge` | P2 | 🔒 | teacher | `/dashboard` | Book health badge expands to quality detail |
| `library-authoring-15-scanned-pdf-warning` | P2 | 🔒 | teacher | `/dashboard` | Scanned (no text layer) PDF surfaces an unreliable-chapters warning |
| `library-authoring-16-beta-cap-enforced` | P2 | 🔒 | teacher | `/dashboard` | Beta teacher is capped to one book and one chapter |

<details><summary>Detailed steps & expected</summary>

**`library-authoring-01-login-smoke` — Teacher logs in and lands on the Library** _(P0, teacher)_
- _Pre:_ An existing teacher/adult account whose profile is already onboarded. Human tester supplies the email + password.
- _Steps:_
  1. Navigate to /login
  1. Hand off to the human tester to type the account email and password and submit (QA agent must not type credentials)
  1. Observe the post-login redirect to /dashboard
  1. Confirm the 'Your library' heading, the 'Upload a textbook…' subhead, and the Upload card are visible
- _Expect:_ Authentication succeeds and the teacher sees the Library page with the upload card and (if any) their book table.

**`library-authoring-02-unauth-redirect` — Signed-out visit to the Library redirects to login** _(P0, anon)_
- _Pre:_ No active session (clear cookies / use a fresh context).
- _Steps:_
  1. Ensure no user is signed in
  1. Navigate directly to /dashboard
  1. Observe the response
- _Expect:_ The server component redirects to /login; the library and any book data are never rendered to an anonymous user.

**`library-authoring-03-onboarding-gate` — Un-onboarded adult is blocked at the onboarding gate before authoring** _(P0, teacher, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ An authenticated adult account (role != student) whose profiles.onboarded_at is NULL. Human tester establishes the session. Requires FEATURE_ONBOARDING=true.
- _Steps:_
  1. With the un-onboarded adult session active, navigate to /dashboard
  1. Observe the redirect to /onboarding
  1. Confirm the Library (upload card / book table) is NOT reachable until onboarding is completed
  1. Optionally: complete the Teacher/Parent confirmation + required fields and confirm you are then allowed into /dashboard
- _Expect:_ The dashboard layout forces the new joiner to /onboarding; authoring surfaces are inaccessible until onboarded_at is stamped. A provisioned/onboarded adult is NOT redirected.

**`library-authoring-04-upload-index-book` — Upload a textbook PDF and see it index into chapters** _(P0, teacher)_
- _Pre:_ Onboarded teacher session. A sample text-based PDF textbook available to the tester.
- _Steps:_
  1. On /dashboard, optionally type a Title and Author in the Upload card
  1. Click the file chooser and select a PDF (confirm the size hint appears and Upload enables)
  1. Click Upload and watch the progress bar advance to Uploading 100% / Finishing…
  1. Confirm a new book row appears showing 'Finding chapters…' (status=indexing)
  1. Wait for AutoRefresh to flip the row to ready, then click to expand it
  1. Confirm a detected chapter list and a Health badge are shown
- _Expect:_ The PDF uploads, a books row is created with status=indexing, the worker detects chapters, and the row becomes an expandable ready book with chapters and a health badge.

**`library-authoring-05-generate-lesson` — Generate a narrated lesson (presentation) for a chapter** _(P0, teacher)_
- _Pre:_ A ready (indexed) book owned by the teacher.
- _Steps:_
  1. Expand a ready book and locate a chapter with no lesson yet
  1. Tick the 'Lesson' checkbox for that chapter
  1. In the revealed Lesson options, choose a Narration style and a Voice
  1. Click 'Generate (1)' and confirm the cell shows queued then processing with a % progress
  1. Wait via AutoRefresh until status is done
  1. Confirm the '▶ Watch' and '⬇ Deck' links appear on the chapter's Lesson cell
- _Expect:_ A presentation generation is queued with the chosen narration_style/tts_voice params, the worker runs it to done, and Watch (video) + Deck (pptx) become available.

**`library-authoring-06-student-blocked-from-authoring` — Student on /dashboard sees assignments only, never authoring controls** _(P0, student)_
- _Pre:_ A student account (human establishes the session). At least one item may be assigned to them.
- _Steps:_
  1. With a student session, navigate to /dashboard
  1. Confirm the student assignment dashboard renders (grouped by class/chapter)
  1. Confirm there is NO Upload card, NO book table, NO Generate/Regenerate/Delete-book controls, and NO branding card
- _Expect:_ A minor's account renders only the read-only assignments view; none of the library-authoring surfaces are exposed, confirming role separation.

**`library-authoring-07-generate-document-kinds` — Batch-generate worksheet, exam, plan, activity and case study for a chapter** _(P1, teacher)_
- _Pre:_ A ready book with a chapter that has no documents generated yet.
- _Steps:_
  1. Expand a ready book and pick a chapter
  1. Tick several document checkboxes (Worksheet, Exam, Plan, Activities, Case study)
  1. Click 'Generate (N)' and confirm each type shows queued/processing
  1. Wait for each to reach done
  1. Confirm every completed document type exposes a '⬇ Download' (.docx) link
- _Expect:_ One generation row per checked kind is queued with sensible default params, the worker produces a .docx per kind, and each becomes downloadable.

**`library-authoring-08-download-artifacts` — Open and download generated artifacts via signed URLs** _(P1, teacher)_
- _Pre:_ A chapter with a done presentation and at least one done document.
- _Steps:_
  1. Click '▶ Watch' on a done lesson and confirm the video opens (signed artifacts URL, new tab)
  1. Click '⬇ Deck' and confirm the .pptx downloads
  1. Click '⬇ Download' on a document kind and confirm the .docx downloads
  1. Confirm none of the links 404 or return an expired-signature error
- _Expect:_ All artifact links resolve to working signed Supabase storage URLs; video plays and Office files download.

**`library-authoring-09-regenerate-lesson` — Regenerate a chapter lesson replaces the old deck/video** _(P1, teacher)_
- _Pre:_ A chapter with a done presentation.
- _Steps:_
  1. On the done lesson cell click '↻ Regenerate'
  1. Accept the confirm 'Regenerate this chapter? The current deck and video will be replaced.'
  1. Confirm a fresh generation appears as queued/processing and takes over the cell
  1. Wait for done and confirm new Watch/Deck links; confirm the old artifacts are gone
- _Expect:_ A new generation is queued and the previous lesson's storage files + row are deleted, so the chapter shows only the regenerated lesson.

**`library-authoring-10-delete-lesson` — Delete a single lesson/document from a chapter** _(P1, teacher)_
- _Pre:_ A chapter (or 'Other lessons' list) with at least one existing generation.
- _Steps:_
  1. Click the ✕ 'Remove lesson' control on a lesson/document
  1. Accept the confirm 'Remove this lesson? This cancels it if it's still running.'
  1. Confirm the item disappears from the chapter after refresh
- _Expect:_ The generation row and its artifacts are removed and the cell reverts to an ungenerated (checkbox) state.

**`library-authoring-11-delete-book` — Delete a whole book from the library** _(P1, teacher)_
- _Pre:_ A book owned by the teacher (ideally a throwaway test upload).
- _Steps:_
  1. On the book row click the ✕ 'Delete book' control
  1. Accept the confirm 'Delete this book? This can't be undone.'
  1. Confirm the book row (and its chapters/section) disappears from the library
- _Expect:_ The book's uploaded PDF and books row are removed and it no longer appears in the library.

**`library-authoring-12-branding-templates` — Upload school Word and PowerPoint branding templates** _(P1, teacher)_
- _Pre:_ Onboarded teacher session; sample .docx and .pptx template files available.
- _Steps:_
  1. Expand the 'School branding' card
  1. Upload a .docx into the Word template slot and confirm it shows '✓ <filename>'
  1. Upload a .pptx into the PowerPoint template slot and confirm '✓ <filename>'
  1. Reload and confirm the summary reads 'templates set' (branding row persisted)
- _Expect:_ Both templates upload to uploads/{uid}/branding and the branding row is upserted so future outputs adopt the school's format/theme.

**`library-authoring-13-cross-tenant-isolation` — Teacher cannot see another owner's books or artifacts** _(P1, teacher)_
- _Pre:_ Two separate teacher accounts (Teacher A and Teacher B, ideally different schools); Teacher B owns at least one book with generated content. Human establishes Teacher A's session.
- _Steps:_
  1. Sign in as Teacher A and load /dashboard
  1. Confirm the library lists ONLY Teacher A's own books, never Teacher B's
  1. Optionally attempt to load one of Teacher B's artifact/signed URLs or book id directly and confirm it is not accessible
- _Expect:_ Ownership filtering + RLS prevent any of Teacher B's books, chapters, or artifacts from appearing in or being reachable from Teacher A's library.

**`library-authoring-14-book-health-badge` — Book health badge expands to quality detail** _(P2, teacher)_
- _Pre:_ A ready book that has a computed health object.
- _Steps:_
  1. On a ready book row, click the 'Health NN · <band>' badge
  1. Confirm the popover opens without toggling the row expansion
  1. Confirm it shows the Text quality / Chapters bars, the pages·chapters·text/scanned facts line, any problems, and a recommendation
- _Expect:_ The health badge renders the index-time quality score with dimensions, facts, problems and recommendation, and clicking it does not collapse/expand the book.

**`library-authoring-15-scanned-pdf-warning` — Scanned (no text layer) PDF surfaces an unreliable-chapters warning** _(P2, teacher)_
- _Pre:_ A scanned/image-only PDF (health.facts.has_text_layer === false) uploaded and indexed.
- _Steps:_
  1. Upload a scanned PDF and wait for it to reach ready
  1. Expand the book row
  1. Confirm the amber 'This looks like a scanned PDF (no text layer)…' warning banner appears above the chapter list
  1. Open the Health badge and confirm the facts line reads 'scanned'
- _Expect:_ The library warns up front that chapter detection and generated content may be unreliable for scanned books, before the teacher generates against them.

**`library-authoring-16-beta-cap-enforced` — Beta teacher is capped to one book and one chapter** _(P2, teacher, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ A beta_tester account (FEATURE_TEACHER_BETA=true) that already owns exactly one book and has generated content for one chapter (pinning it).
- _Steps:_
  1. Load /dashboard as the beta teacher and confirm the Upload card is replaced by the 'beta is limited to 1 book' notice
  1. Expand the owned book
  1. Confirm the pinned chapter still shows generate controls
  1. Confirm every OTHER chapter shows the 'Beta: 1 chapter — locked' chip and no generate checkboxes / Generate-all button
- _Expect:_ The beta caps are visibly enforced in the UI (no second book, only the pinned chapter generatable), matching the DB-trigger enforcement server-side.

</details>

### Classes & students  `classes-students` — 16 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `classes-students-01` | P0 | 🔒 | teacher | `/dashboard` | Teacher creates a class |
| `classes-students-02` | P1 | 🔒 | teacher | `/dashboard` | Duplicate class name is blocked (case-insensitive) |
| `classes-students-03` | P0 | 🔒🔑 | teacher | `/dashboard` | Provision students and hand out login credentials |
| `classes-students-04` | P1 | 🔒 | teacher | `/dashboard` | Cross-tenant roster isolation (no other school's students visible) |
| `classes-students-05` | P0 | 🔑 | student | `/login` | Student first sign-in with ID is forced through password reset |
| `classes-students-06` | P0 | 🔒 | teacher | `/dashboard` | Assign a generated lesson/chapter to a class |
| `classes-students-07` | P1 | 🔒 | student | `/dashboard` | Student completes an assigned lesson (watch to 100%) |
| `classes-students-08` | P1 | 🔒 | teacher | `/dashboard` | Teacher views per-class student progress |
| `classes-students-09` | P1 | 🔒⚠️ | teacher | `/dashboard` | Reset a student's password from the roster |
| `classes-students-10` | P1 | 🔒 | teacher | `/dashboard` | Beta student cap (2 max) enforced in UI and API |
| `classes-students-11` | P0 | 🔒 | teacher | `/api/students` | Provisioning guard: not-your-class and not-signed-in are rejected |
| `classes-students-12` | P0 | 🔒 | student | `/dashboard` | Student role sees only My Lessons, never the teacher library |
| `classes-students-13` | P1 | 🔒 | school_admin | `/dashboard/school/admin` | Admin grants a teacher coordinator scope |
| `classes-students-14` | P0 | 🔒 | teacher | `/dashboard/school/admin` | Non-admin blocked from coordinator management |
| `classes-students-15` | P2 | 🔒 | coordinator | `/dashboard/school/access` | Access model page shows only the coordinator's own slice |
| `classes-students-16` | P2 | 🔒 | school_admin | `/dashboard/school/admin` | Admin removes a scope and revokes coordinator access |

<details><summary>Detailed steps & expected</summary>

**`classes-students-01` — Teacher creates a class** _(P0, teacher)_
- _Pre:_ Signed in as an adult (teacher/admin/parent) account.
- _Steps:_
  1. Open /dashboard and click the 'Classes & students' summary to expand the card
  1. Type a unique class name (e.g. '5A') in the 'New class' field and '5' in the 'Grade (optional)' field
  1. Click 'Create class'
- _Expect:_ A new class row '5A · 5' appears in the list showing '0 students' and a 'join: XXXX' code chip; the input clears and no error is shown.

**`classes-students-02` — Duplicate class name is blocked (case-insensitive)** _(P1, teacher)_
- _Pre:_ The teacher already owns a class named '5A'.
- _Steps:_
  1. Expand the 'Classes & students' card
  1. Type '5a' (different case, same name) in the 'New class' field
  1. Click 'Create class'
- _Expect:_ An inline red error 'You already have a class named "5a".' appears and no second class row is created.

**`classes-students-03` — Provision students and hand out login credentials** _(P0, teacher)_
- _Pre:_ Teacher owns at least one class. NOTE: this creates real student auth accounts, so the account-creating click is handed to the human tester.
- _Steps:_
  1. Expand a class row inside 'Classes & students'
  1. Under 'Add students' fill First name / Last name / Parent email in the first row
  1. Click '+ Add row' and fill a second student
  1. HUMAN TESTER clicks 'Create logins'
- _Expect:_ A green 'Logins created — give these to parents' panel lists each student with an ID (first.last), a temporary Password, and the parent email; the roster above now lists the new students with their IDs; 'Copy all' copies a tab-separated credential block to the clipboard.

**`classes-students-04` — Cross-tenant roster isolation (no other school's students visible)** _(P1, teacher)_
- _Pre:_ At least two teachers/schools seeded; signed in as teacher A.
- _Steps:_
  1. Open /dashboard and expand 'Classes & students'
  1. Inspect the class list and each expanded roster (student names, IDs, parent emails)
- _Expect:_ Only teacher A's own classes and their enrolled students appear; no class, student ID, join code, or parent email belonging to another teacher or school is ever shown (RLS scopes classes by teacher_id and roster by enrollment).

**`classes-students-05` — Student first sign-in with ID is forced through password reset** _(P0, student)_
- _Pre:_ A freshly provisioned student ID + temporary password (from scenario 03), held by the human tester.
- _Steps:_
  1. At /login type the student ID with no '@' (e.g. 'aisha.khan') in the 'Email or student ID' field
  1. Type the temporary password and submit
  1. Set a new password on the redirected screen
- _Expect:_ Sign-in succeeds but the app immediately redirects to /auth/update-password (must_reset_password gate); after choosing a new password the student lands on the 'My lessons' dashboard.

**`classes-students-06` — Assign a generated lesson/chapter to a class** _(P0, teacher)_
- _Pre:_ Teacher has a finished generation (a 'done' lesson) and a class with at least one enrolled student.
- _Steps:_
  1. In the library, open the book/chapter row and click the assign action ('Assign to class')
  1. In the modal pick the target class from the dropdown
  1. Set a due date (optional) and click 'Assign'
- _Expect:_ The modal shows '✓ Assigned' then closes; the class's enrolled student, on their own dashboard, now sees the assigned item grouped under that class → chapter with the due date shown (written to generation_shares).

**`classes-students-07` — Student completes an assigned lesson (watch to 100%)** _(P1, student)_
- _Pre:_ Authenticated student session; a lesson with a video artifact has been assigned to the student's class.
- _Steps:_
  1. On 'My lessons' click '▶ Watch' on an assigned lesson
  1. Let the video play through to the end
  1. Close the player, then re-open the same lesson
- _Expect:_ The item badge flips to '✓ Completed' when the video ends; re-opening the finished lesson changes the badge to '↻ Revised' (revision_count increments).

**`classes-students-08` — Teacher views per-class student progress** _(P1, teacher)_
- _Pre:_ A class with at least one enrolled student and at least one assigned item.
- _Steps:_
  1. Expand the class row in 'Classes & students'
  1. Click 'Show progress'
- _Expect:_ A table renders one row per enrolled student with Completed (n/total), Revised, Incomplete, and Overdue counts; the Overdue value is styled red when items are past their due date.

**`classes-students-09` — Reset a student's password from the roster** _(P1, teacher)_
- _Pre:_ A class with at least one enrolled student.
- _Steps:_
  1. Expand the class and find a student row in the roster
  1. Click 'Reset password'
  1. Click 'Yes, reset' on the inline confirm
- _Expect:_ A new temporary password is displayed once with a 'Copy' button and a '(shown once)' note; the student's old password is invalidated and they must choose a new one at next sign-in.

**`classes-students-10` — Beta student cap (2 max) enforced in UI and API** _(P1, teacher, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ Teacher flagged beta_tester with 2 students already enrolled across their classes; FEATURE_TEACHER_BETA on.
- _Steps:_
  1. Expand a class and look at the 'Add students' area
  1. (Optional) Attempt to provision a 3rd student via POST /api/students
- _Expect:_ The add-students form is replaced by the amber message 'Beta is limited to 2 students — you've added both.'; the slots indicator reads 'Beta: 0 of 2 slots left'; a 3rd student via the API returns HTTP 400 with the cap message (DB trigger also rejects it regardless of the flag).

**`classes-students-11` — Provisioning guard: not-your-class and not-signed-in are rejected** _(P0, teacher)_
- _Pre:_ Signed in as teacher A; know a classId owned by a different teacher B.
- _Steps:_
  1. While signed in as teacher A, POST /api/students with classId = a class owned by teacher B and one student payload
  1. Separately, POST /api/students with no authenticated session
- _Expect:_ The cross-owner request returns 403 {"error":"Class not found or not yours."} and creates no auth user or enrollment; the unauthenticated request returns 401 {"error":"Not signed in."}.

**`classes-students-12` — Student role sees only My Lessons, never the teacher library** _(P0, student)_
- _Pre:_ Authenticated student account (past the reset gate).
- _Steps:_
  1. Sign in as a student and land on /dashboard
  1. Inspect the header tabs and the page body
- _Expect:_ The header shows no Library/Analytics/School/Invites tabs and the role label reads 'student'; the body is the 'My lessons' assignments view — the teacher 'Your library', 'Classes & students' card, and provisioning UI are never rendered.

**`classes-students-13` — Admin grants a teacher coordinator scope** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; at least one class with a grade set (grades list non-empty) and a teacher member in the same school.
- _Steps:_
  1. Open /dashboard/school/admin and find 'Coordinators & scopes'
  1. Under 'Give a teacher coordinator access' pick a teacher, choose a grade, leave subject as 'All subjects'
  1. Click 'Grant access'
- _Expect:_ The teacher moves into the coordinators list tagged 'teacher & coordinator' with a 'Grade N' scope chip; on their next load they gain the School / Teachers / Access tabs and their label becomes 'teacher & coordinator'.

**`classes-students-14` — Non-admin blocked from coordinator management** _(P0, teacher, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; signed in as a plain teacher (no admin, no scope).
- _Steps:_
  1. Navigate directly to /dashboard/school/admin
  1. Separately, POST /api/coordinators with {"action":"add_scope","userId":"<any>","grade":"5"}
- _Expect:_ The page redirects to /dashboard with no admin UI rendered; the API returns 403 {"error":"School admin only."} and writes nothing.

**`classes-students-15` — Access model page shows only the coordinator's own slice** _(P2, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; a teacher granted a single coordinator scope (e.g. Grade 5).
- _Steps:_
  1. Sign in as the scoped teacher and open /dashboard/school/access
  1. Read the 'Your access' section
- _Expect:_ The page shows the model table plus a 'Your access' card with only the granted 'Grade 5' (+subject) chip and a resolved footprint (N classes / students / teachers) and the statement 'Anything in other grades is invisible to you.'; an unscoped, non-admin teacher who visits is redirected to /dashboard.

**`classes-students-16` — Admin removes a scope and revokes coordinator access** _(P2, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; an existing coordinator with at least one scope chip.
- _Steps:_
  1. In 'Coordinators & scopes' click the '×' on one of the coordinator's scope chips
  1. Then click 'Remove coordinator access' for that person
- _Expect:_ The scope chip disappears immediately; after revoke the person drops out of the coordinators list back to a plain teacher (all their coordinator_scope rows cleared), losing the School/Teachers/Access tabs on next load.

</details>

### Parent portal  `parent-portal` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `parent-portal-signup-01` | P0 | 🔑 | anon | `/signup` | Self-serve parent signup exposes and creates a Parent account |
| `parent-portal-add-first-child-02` | P0 | 🔒 | parent | `/dashboard/children` | Parent adds their first child and nav tabs appear |
| `parent-portal-children-view-isolation-03` | P0 | 🔒 | parent | `/dashboard/children` | My Children shows only own children, school work read-only, with scores |
| `parent-portal-generate-paper-04` | P1 | 🔒 | parent | `/dashboard/test-papers` | Parent uploads a book and generates a test paper for a chapter |
| `parent-portal-assign-paper-05` | P1 | 🔒 | parent | `/dashboard/test-papers` | Parent assigns a finished test paper to a child with a due date |
| `parent-portal-reassign-updates-due-06` | P2 | 🔒 | parent | `/dashboard/test-papers` | Re-assigning the same paper to the same child updates the due date |
| `parent-portal-full-authoring-07` | P1 | 🔒 | parent | `/dashboard` | Parent authors a full narrated lesson from the Library (migration 0035) |
| `parent-portal-reset-child-password-08` | P1 | 🔒 | parent | `/dashboard/children` | Parent resets a linked child's password |
| `parent-portal-child-cap-09` | P1 | 🔒 | parent | `/dashboard/children` | Child cap is enforced when adding children |
| `parent-portal-guard-student-blocked-10` | P0 | 🔒 | student | `/dashboard/children` | Student accounts are blocked from all parent surfaces |
| `parent-portal-guard-flag-off-11` | P1 | 🔒 | any | `/dashboard/children` | With the portal flag off, parent surfaces redirect and the API 404s |
| `parent-portal-admin-issue-invite-12` | P1 | 🔒 | school_admin | `/dashboard/invites` | School admin issues a parent invite with child mapping |
| `parent-portal-invite-accept-13` | P1 | 🔑 | anon | `/invite/[token]` | Invitee accepts a school parent invite and is linked to the child |
| `parent-portal-invite-guards-14` | P1 | — | any | `/invite/[token]` | Invite guard paths: dead links, email mismatch, and student blocked |
| `parent-portal-ai-grounding-child-book-15` | P2 | 🔒 | parent | `/dashboard/children` | Parent AI assistant grounds on the linked child's books |

<details><summary>Detailed steps & expected</summary>

**`parent-portal-signup-01` — Self-serve parent signup exposes and creates a Parent account** _(P0, anon, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ NEXT_PUBLIC_FEATURE_PARENT_PORTAL=true so the client role picker renders the Parent tab. Use a fresh email the human tester supplies.
- _Steps:_
  1. Open /signup
  1. Confirm the role picker shows three options: Teacher, Student, and Parent (Parent only appears when the client flag is on)
  1. Click the Parent role button and verify it highlights
  1. HAND TO HUMAN: type full name, a fresh email, and a password (min 6), then submit 'Create account'
  1. Complete email confirmation if required, then sign in
  1. Observe the landing dashboard header label reads 'parent'
- _Expect:_ Parent option is selectable, account is created with role=parent, and after sign-in the app header shows the 'parent' label and lands on the Library.

**`parent-portal-add-first-child-02` — Parent adds their first child and nav tabs appear** _(P0, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Signed in as a parent with zero linked children. Note: the 'My Children'/'Test Papers' nav tabs are hidden until the first link exists, so navigate to /dashboard/children directly by URL.
- _Steps:_
  1. Navigate directly to /dashboard/children
  1. Confirm the empty state reads 'No children linked yet' and an 'Add a child' card is present
  1. Click '+ Add child', type a First name and Last name, click 'Create login'
  1. Read the one-time credentials box: a Child ID (username) and a Temporary password are displayed
  1. Reload the page and confirm the new child now has its own section (School work / From you)
  1. Confirm the header now shows the 'My Children' and 'Test Papers' nav tabs
- _Expect:_ A child login is provisioned (child ID + temp password shown once), the child appears as a section on the page, and the My Children + Test Papers tabs become visible in the header.

**`parent-portal-children-view-isolation-03` — My Children shows only own children, school work read-only, with scores** _(P0, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Parent linked to at least one child who is enrolled in a school class that has assigned content; the school/class also contains OTHER students not linked to this parent.
- _Steps:_
  1. Open /dashboard/children
  1. Confirm only this parent's linked child/children render as sections — no classmates or other families appear
  1. Under 'School work' verify class-assigned items are listed with a status chip, optional score (e.g. 8/10), due date, and 'from <class>' attribution
  1. Confirm school-work rows are read-only (no assign/delete controls)
  1. Verify an overdue, not-yet-submitted item shows its due date in the warning color
  1. Confirm items the parent assigned appear only under 'From you', never duplicated into 'School work'
- _Expect:_ Parent sees exactly their linked children and each child's own assignments/progress/scores; no other students' data is visible (RLS isolation), and school work is presented read-only.

**`parent-portal-generate-paper-04` — Parent uploads a book and generates a test paper for a chapter** _(P1, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Worker/generation pipeline deployed. Have a small textbook PDF ready.
- _Steps:_
  1. Open /dashboard/test-papers
  1. Upload a textbook PDF and wait for indexing to complete (chapters appear automatically)
  1. For one chapter click 'Generate test paper' and confirm the chip flips to 'generating N%'
  1. Wait for auto-refresh; confirm the chip reaches 'done' and a 'Download' link plus 'Assign to child' button appear
  1. Click Download and confirm a DOCX test paper file downloads
- _Expect:_ The uploaded book indexes into chapters, a test paper generates to completion, and the finished DOCX is downloadable — proving the parent authoring pipeline works end-to-end.

**`parent-portal-assign-paper-05` — Parent assigns a finished test paper to a child with a due date** _(P1, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Parent has at least one linked child AND at least one completed ('done') test paper.
- _Steps:_
  1. Open /dashboard/test-papers
  1. On a done chapter click 'Assign to child'
  1. Pick the child in the dropdown, set a due date, click 'Assign'
  1. Confirm the button shows 'Assigned ✓'
  1. Navigate to /dashboard/children and confirm the paper now appears under that child's 'From you' section with the chosen due date and a 'not started' status
- _Expect:_ The direct (student-targeted) share is created and the assigned paper surfaces under the child's 'From you' list with the due date; the child (on their own dashboard) would see it under 'From your parent'.

**`parent-portal-reassign-updates-due-06` — Re-assigning the same paper to the same child updates the due date** _(P2, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ A test paper already assigned to a child (from scenario 05).
- _Steps:_
  1. Open /dashboard/test-papers
  1. Click 'Assign to child' on the already-assigned paper, select the same child, choose a DIFFERENT due date, click Assign
  1. Confirm it succeeds with 'Assigned ✓' and no duplicate-key error is shown
  1. Go to /dashboard/children and confirm the child's 'From you' row now reflects the updated due date (not a duplicated row)
- _Expect:_ The duplicate assignment is handled gracefully (insert-then-update on 23505): the due date is refreshed rather than erroring or creating a second share.

**`parent-portal-full-authoring-07` — Parent authors a full narrated lesson from the Library (migration 0035)** _(P1, parent)_
- _Pre:_ Signed in as a parent (portal enabled). An indexed book owned by the parent. This proves the old 'parents: test papers only' DB trigger was dropped (0035).
- _Steps:_
  1. Open /dashboard (Library) as the parent
  1. Expand a book and, on a chapter, generate a full lesson/presentation (a kind OTHER than exam_paper)
  1. Confirm generation is accepted and queues/processes with NO 'Parent accounts can generate test papers only' error
  1. Wait for it to finish and confirm the lesson artifacts (deck/video) become available
- _Expect:_ A parent can now generate any artifact kind (not just exam_paper) from the Library — the generation succeeds instead of being rejected by the removed parent-kind trigger.

**`parent-portal-reset-child-password-08` — Parent resets a linked child's password** _(P1, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Parent has a linked child.
- _Steps:_
  1. Open /dashboard/children
  1. In the child's section click the reset-password control next to their name
  1. Confirm/execute the reset
  1. Verify a new temporary password is surfaced for the parent to hand to the child
  1. Confirm the action is scoped only to the parent's own child (no reset control for anyone unlinked)
- _Expect:_ The parent-of-linked-child reset path succeeds (reset-scope 'parent' branch), producing a new temporary password; the child must reset it on next sign-in.

**`parent-portal-child-cap-09` — Child cap is enforced when adding children** _(P1, parent, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Beta/capped parent (effective children cap = 2, e.g. beta_tester or max_children=2) who already has children up to one below the cap.
- _Steps:_
  1. Open /dashboard/children and add children until at the cap (e.g. 2)
  1. Attempt to add ONE more child via 'Add a child' > 'Create login'
  1. Confirm the request is rejected with a friendly cap message (e.g. 'limited to 2 children')
  1. Confirm no orphan child login/credentials are shown and the child count does not increase
- _Expect:_ The DB beta_child_cap trigger (with the API pre-check) blocks exceeding the cap; the parent sees a clear limit message and no partial/orphan account is created.

**`parent-portal-guard-student-blocked-10` — Student accounts are blocked from all parent surfaces** _(P0, student, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Signed in as a student account.
- _Steps:_
  1. As a student, navigate to /dashboard/children and confirm you are redirected to /dashboard (student dashboard)
  1. Navigate to /dashboard/test-papers and confirm you are redirected to /dashboard
  1. Confirm no 'My Children'/'Test Papers' tabs are present in the header for a student
  1. OPTIONAL (dev/console): POST /api/children as the student session and confirm HTTP 403 'Not available for student accounts.'
- _Expect:_ Students cannot reach or use parent surfaces: both pages redirect to /dashboard, the tabs are absent, and the children-provisioning API rejects students with 403.

**`parent-portal-guard-flag-off-11` — With the portal flag off, parent surfaces redirect and the API 404s** _(P1, any, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Requires a build/environment with FEATURE_PARENT_PORTAL unset/false (staging toggle). In prod soft-launch the flag is ON, so this is an env-gated negative test.
- _Steps:_
  1. With FEATURE_PARENT_PORTAL off, sign in as an adult and navigate to /dashboard/children — confirm redirect to /dashboard
  1. Navigate to /dashboard/test-papers — confirm redirect to /dashboard
  1. Confirm the signup page shows no Parent role option (client flag off)
  1. OPTIONAL: POST /api/children and confirm HTTP 404 'Not enabled.'
- _Expect:_ When the flag is off the entire parent portal is dark: pages redirect to /dashboard, the signup Parent option is hidden, and /api/children returns 404.

**`parent-portal-admin-issue-invite-12` — School admin issues a parent invite with child mapping** _(P1, school_admin, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Signed in as a school_admin whose account is linked to a school that has at least one student on file. Portal flag on so the Parent role option renders.
- _Steps:_
  1. Open /dashboard/invites
  1. In the create form, select role 'Parent' and type the parent's email
  1. Confirm the school's students appear as selectable chips, with students whose parent_email matches the typed address floating up as 'suggested'
  1. Select at least one child and click 'Create invite'
  1. Confirm a shareable invite link is generated and can be copied
  1. Confirm attempting a parent invite with NO child selected is blocked with 'Pick at least one child for a parent invite.'
- _Expect:_ A school_admin can mint a parent invite bound to specific children; suggested matches surface by parent_email, the link is copyable, and child-less parent invites are refused.

**`parent-portal-invite-accept-13` — Invitee accepts a school parent invite and is linked to the child** _(P1, anon, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ A valid, unaccepted parent invite link (from scenario 12) for a fresh email the human tester controls. Substitute the real token in the path.
- _Steps:_
  1. Open the invite link /invite/<token> while signed out
  1. Confirm the page shows 'You're invited', the school name, the Parent role chip, and the invited email
  1. HAND TO HUMAN: complete 'Accept & create account' with full name + password (or Google for that email)
  1. After auth, confirm redirect to /dashboard/children
  1. Confirm the mapped child now appears; if the invite email matched the child's parent_email on file the link is verified (no 'unverified' note), otherwise it shows 'unverified link · confirm with the school'
  1. Confirm the header label is 'parent' (a fresh default account was elevated to parent; an existing teacher would instead keep 'teacher' and gain '& parent')
- _Expect:_ The invitee authenticates as the invited email, is granted the parent link to the mapped child, lands on /dashboard/children, and verification state reflects the parent_email match.

**`parent-portal-invite-guards-14` — Invite guard paths: dead links, email mismatch, and student blocked** _(P1, any, flag: `FEATURE_PARENT_PORTAL`)_
- _Pre:_ Have three tokens/states available: an invalid/garbage token, an expired-or-already-accepted invite, and a valid parent invite plus a signed-in session whose email differs from the invited email. A student session for the last check.
- _Steps:_
  1. Open /invite/<garbage-token> and confirm 'Invitation unavailable' with 'This invitation link is invalid.'
  1. Open an expired or already-accepted invite and confirm the matching unavailable message (expired / already used)
  1. While signed in as a DIFFERENT email, open a valid parent invite and confirm it asks you to sign out and use the invited email (accept route redirects back with the email-mismatch reason)
  1. While signed in as a STUDENT, attempt to accept a parent invite and confirm it is refused (redirect back with the 'student cannot accept a parent invitation' reason)
- _Expect:_ Invalid/expired/used invites show the unavailable page; an email mismatch forces sign-out to the invited email; a student account is refused parent elevation — none of these grant a link.

**`parent-portal-ai-grounding-child-book-15` — Parent AI assistant grounds on the linked child's books** _(P2, parent, flag: `FEATURE_AI_ASSISTANT`)_
- _Pre:_ FEATURE_AI_ASSISTANT (or FEATURE_AI_TUTOR) enabled. Parent has NO own uploaded books, but a linked child is studying an indexed book covering a known topic.
- _Steps:_
  1. As the parent, open the AI assistant launcher (bottom-right) on a dashboard page
  1. Ask a question about a topic that appears in the child's book's chapters
  1. Confirm the assistant answers in-scope (grounded on the child's book), not with an off-topic/no-book refusal
  1. Ask a clearly unrelated question and confirm it is treated as off-topic and redirects to the in-scope topics
- _Expect:_ With no own books, the parent's grounding scope falls back to their linked children's books (scope.ts parent fallback): in-topic questions are answered, off-topic ones are declined with real topic suggestions.

</details>

### AI Teaching Assistant  `ai-assistant` — 16 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `ai-assistant-launcher-visible-01` | P0 | 🔒 | any | `/dashboard` | Floating Assistant launcher appears on every dashboard page for a logged-in user |
| `ai-assistant-open-greeting-02` | P0 | 🔒 | student | `/dashboard` | Opening the panel warm-starts a greeting and loads book scope |
| `ai-assistant-in-scope-answer-03` | P0 | 🔒 | student | `/dashboard` | In-scope question returns a streamed, book-grounded answer with a source tag |
| `ai-assistant-off-topic-decline-04` | P1 | 🔒 | student | `/dashboard` | Off-topic question is warmly declined and redirected to real in-scope topics |
| `ai-assistant-no-book-empty-05` | P1 | 🔒 | any | `/dashboard` | User with no books in scope sees the empty state and a disabled input |
| `ai-assistant-homework-guard-06` | P1 | 🔒 | student | `/dashboard` | Assistant refuses to hand over final graded answers, gives hints instead |
| `ai-assistant-read-aloud-07` | P1 | 🔒 | student | `/dashboard` | Read-aloud is on by default, shows a Stop control, and the toggle persists |
| `ai-assistant-mic-dictation-08` | P2 | 🔒 | student | `/dashboard` | Mic button dictates a spoken question into the input (speech-capable browsers) |
| `ai-assistant-followup-stays-on-topic-09` | P2 | 🔒 | student | `/dashboard` | A follow-up with no topical words stays anchored to the active chapter |
| `ai-assistant-math-verified-10` | P1 | 🔒 | student | `/dashboard` | In-scope math question returns worked, verified steps |
| `ai-assistant-parent-children-books-11` | P1 | 🔒 | parent | `/dashboard` | Parent with no own books gets grounding on their linked children's books |
| `ai-assistant-console-launcher-12` | P2 | 🔒 | platform_admin | `/console` | Assistant launcher is also present on the platform console for staff |
| `ai-assistant-unauth-401-13` | P1 | — | anon | `/api/assistant` | Guard: unauthenticated request to /api/assistant is rejected |
| `ai-assistant-flag-off-404-14` | P1 | 🔒 | any | `/api/assistant` | Guard: with the feature flag off, the surface is fully dark |
| `ai-assistant-input-validation-15` | P2 | 🔒 | student | `/dashboard` | Input is length-capped and empty questions are rejected |
| `ai-assistant-cross-tenant-scope-16` | P1 | 🔒 | student | `/dashboard` | Guard: assistant scope and history are limited to the user's own data |

<details><summary>Detailed steps & expected</summary>

**`ai-assistant-launcher-visible-01` — Floating Assistant launcher appears on every dashboard page for a logged-in user** _(P0, any, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ FEATURE_AI_ASSISTANT and NEXT_PUBLIC_FEATURE_AI_ASSISTANT both true; user has an active session.
- _Steps:_
  1. Log in and land on /dashboard.
  1. Look at the bottom-right corner of the viewport.
  1. Confirm a rounded pill button labelled '🎓 Assistant' (aria-label 'Open the AI Teaching Assistant', data-tour='assistant') is visible and fixed above the page.
  1. Navigate to another dashboard sub-page (e.g. /dashboard/library) and confirm the same button is still present bottom-right.
- _Expect:_ The '🎓 Assistant' launcher is visible bottom-right on every dashboard surface, and does not overlap the bottom-left 'Report a problem' widget.

**`ai-assistant-open-greeting-02` — Opening the panel warm-starts a greeting and loads book scope** _(P0, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with at least one assigned lesson/book in scope.
- _Steps:_
  1. Click the '🎓 Assistant' launcher.
  1. Observe the modal panel opens centered with header 'AI Teaching Assistant' and subtitle 'Answers from your books'.
  1. Note the brief 'Getting your books ready…' placeholder while the warm-start GET /api/assistant resolves.
  1. Wait for the greeting message to appear.
- _Expect:_ A greeting bubble appears that addresses the student by first name and names their book(s) ('Ask me anything from "<book>"…'); the text input is enabled with placeholder 'Ask about your books…' and the 'Ask' button is present.

**`ai-assistant-in-scope-answer-03` — In-scope question returns a streamed, book-grounded answer with a source tag** _(P0, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student whose in-scope book has a chapter matching the question keywords (e.g. a Biology book with a 'Photosynthesis' chapter).
- _Steps:_
  1. Open the Assistant panel and wait for the greeting.
  1. Type a question that matches a real chapter, e.g. 'How does photosynthesis work?'
  1. Click 'Ask' (button shows '…' while busy).
  1. Watch the assistant bubble fill in incrementally (streamed text).
- _Expect:_ The answer streams in and, below the assistant bubble, a green '📖 from your Chapter N — <Chapter Title>' source tag appears; the answer explains the concept from the book (hints/method), not a raw off-topic response.

**`ai-assistant-off-topic-decline-04` — Off-topic question is warmly declined and redirected to real in-scope topics** _(P1, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with in-scope books; the question shares no keywords with any chapter.
- _Steps:_
  1. Open the Assistant panel and wait for the greeting.
  1. Ask something clearly outside the curriculum, e.g. 'Who won the last World Cup?'
  1. Click 'Ask'.
- _Expect:_ The assistant replies with a warm decline like 'That's outside what we're studying right now — but I'd love to help with your book! We could go over "<real chapter>", …', naming actual in-scope chapter titles; NO '📖 from your…' source tag is shown (this path is deterministic, no model call).

**`ai-assistant-no-book-empty-05` — User with no books in scope sees the empty state and a disabled input** _(P1, any, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a user with NO assigned lessons, no owned books, and (if a parent) no linked children with books.
- _Steps:_
  1. Open the Assistant panel.
  1. Wait for the warm-start to resolve.
  1. Inspect the greeting and the input row.
- _Expect:_ The greeting is the no-book message ('I don't see a book in your study list yet…'); the text input is disabled with placeholder 'No book yet', the mic button (if shown) is disabled, and the 'Ask' button is disabled.

**`ai-assistant-homework-guard-06` — Assistant refuses to hand over final graded answers, gives hints instead** _(P1, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with an in-scope book that has quiz/homework questions.
- _Steps:_
  1. Open the Assistant panel.
  1. Ask for a direct answer to graded work, e.g. 'Just give me the final answer to quiz question 3, don't explain.'
  1. Click 'Ask' and read the streamed reply.
- _Expect:_ The assistant does NOT dump the final graded answer; it responds with guidance, hints, and method to help the student reach the answer themselves (honest-mastery rule), while staying grounded in the book.

**`ai-assistant-read-aloud-07` — Read-aloud is on by default, shows a Stop control, and the toggle persists** _(P1, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with in-scope books; testing browser supports speechSynthesis.
- _Steps:_
  1. Open the Assistant panel; confirm the header shows '🔊 Read aloud' (pressed/on).
  1. Ask an in-scope question and, while the answer streams, confirm a red '■ Stop' button appears in the header and audio plays.
  1. Click '■ Stop' and confirm speech stops.
  1. Click 'Read aloud' to toggle it OFF (shows '🔈 Read aloud'), close and reopen the panel, and confirm it stays OFF.
- _Expect:_ Read-aloud defaults ON; a Stop control appears while speaking and halts audio; the on/off preference persists across panel reopen (stored in localStorage 'assistant.readAloud').

**`ai-assistant-mic-dictation-08` — Mic button dictates a spoken question into the input (speech-capable browsers)** _(P2, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with in-scope books; browser supports SpeechRecognition and mic permission can be granted by the human tester.
- _Steps:_
  1. Open the Assistant panel and confirm a '🎤' mic button appears left of the input.
  1. Click the mic (button turns red/pulsing, placeholder becomes 'Listening…'); grant mic permission if prompted.
  1. Speak a short question, then stop.
  1. Confirm the transcript populates the input field and focus returns to the input.
- _Expect:_ Dictation fills the input with the spoken transcript and the mic returns to idle; if the browser has no SpeechRecognition support the mic button is simply absent (no error).

**`ai-assistant-followup-stays-on-topic-09` — A follow-up with no topical words stays anchored to the active chapter** _(P2, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with an in-scope book; a prior in-scope answer was just given in this session.
- _Steps:_
  1. Open the panel and ask an in-scope question so an answer with a '📖 from your Chapter N' tag appears.
  1. Immediately ask a bare follow-up with no subject keywords, e.g. 'Can you explain that again more simply?'
  1. Click 'Ask'.
- _Expect:_ The follow-up is answered in scope on the SAME chapter (not declined as off-topic); the source tag references the same chapter the conversation was anchored to.

**`ai-assistant-math-verified-10` — In-scope math question returns worked, verified steps** _(P1, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with an in-scope maths/physics book; MATH_SVC_URL and MATH_SVC_TOKEN configured on the server.
- _Steps:_
  1. Open the panel and ask a computation grounded in the curriculum, e.g. 'Solve x^2 - 5x + 6 = 0 and show the steps.'
  1. Click 'Ask' and read the streamed answer.
- _Expect:_ The assistant walks through the setup and narrates the computed result (roots x=2 and x=3) as verified steps; it never presents an unverified number as certain. If the math service is unavailable it explains the method conceptually rather than guessing a number.

**`ai-assistant-parent-children-books-11` — Parent with no own books gets grounding on their linked children's books** _(P1, parent, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a parent who owns no books but has at least one linked child studying a book.
- _Steps:_
  1. Open the Assistant panel.
  1. Confirm the greeting names a book (the child's in-scope book), not the no-book message.
  1. Ask a question about a chapter in that child's book and click 'Ask'.
- _Expect:_ The panel is ready (input enabled) and answers are grounded in the child's book with a '📖 from your Chapter…' tag; a parent with no children and no books instead sees the no-book empty state.

**`ai-assistant-console-launcher-12` — Assistant launcher is also present on the platform console for staff** _(P2, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a platform admin; FEATURE_PLATFORM_CONSOLE and FEATURE_AI_ASSISTANT both true.
- _Steps:_
  1. Navigate to /console.
  1. Confirm the '🎓 Assistant' launcher is present bottom-right.
  1. Open it and confirm the panel loads a greeting (or the no-book empty state if the admin has no in-scope books).
- _Expect:_ The launcher and panel render on the console shell just as on the dashboard; the surface never errors for a staff account.

**`ai-assistant-unauth-401-13` — Guard: unauthenticated request to /api/assistant is rejected** _(P1, anon, flag: `FEATURE_AI_ASSISTANT`)_
- _Pre:_ FEATURE_AI_ASSISTANT true; no active session (logged out / no auth cookie).
- _Steps:_
  1. In a logged-out browser context, issue GET /api/assistant.
  1. Issue POST /api/assistant with body {"question":"hi"}.
  1. Inspect the HTTP status and JSON body of both.
- _Expect:_ Both return HTTP 401 with body {"error":"Not signed in."}; no greeting, session, book data, or streamed answer is leaked to an anonymous caller.

**`ai-assistant-flag-off-404-14` — Guard: with the feature flag off, the surface is fully dark** _(P1, any, flag: `FEATURE_AI_ASSISTANT`)_
- _Pre:_ FEATURE_AI_ASSISTANT set to anything other than 'true' (server flag off).
- _Steps:_
  1. As a signed-in user, load /dashboard and confirm NO '🎓 Assistant' launcher renders (client flag off).
  1. Issue GET /api/assistant and POST /api/assistant while signed in.
  1. Inspect the responses.
- _Expect:_ The launcher is absent from every page and both API methods return HTTP 404 with body {"error":"Not available."} — the flag is the authoritative gate.

**`ai-assistant-input-validation-15` — Input is length-capped and empty questions are rejected** _(P2, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Signed in as a student with in-scope books.
- _Steps:_
  1. Open the panel; confirm the 'Ask' button is disabled while the input is empty.
  1. Type a very long string and confirm the input stops accepting characters at 600 (maxLength).
  1. Optionally, issue POST /api/assistant with body {"question":""} and check the response.
- _Expect:_ The 'Ask' button stays disabled for empty/whitespace input; the input caps at 600 characters; a direct empty POST returns HTTP 400 {"error":"Ask a question."}.

**`ai-assistant-cross-tenant-scope-16` — Guard: assistant scope and history are limited to the user's own data** _(P1, student, flag: `NEXT_PUBLIC_FEATURE_AI_ASSISTANT`)_
- _Pre:_ Two students (A and B) in different classes/tenants studying different books; sessions available for each.
- _Steps:_
  1. Sign in as Student A, open the panel, and note which book(s) the greeting names.
  1. Ask a question that only Student B's (unrelated) book would cover.
  1. Confirm A gets an off-topic decline (B's book is not in A's scope), not an answer grounded in B's book.
- _Expect:_ Student A's greeting and grounding reference only A's own in-scope books; questions answerable solely from another tenant's book are declined as off-topic, and A can never see B's chat history (RLS-scoped to the owning student).

</details>

### AI Tutor / Ask Coach / TAL board  `ai-tutor-tal` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `ai-tutor-tal-01` | P0 | 🔒 | teacher | `/dashboard` | Teacher asks a text question and gets a grounded streamed answer |
| `ai-tutor-tal-02` | P0 | 🔒 | teacher | `/dashboard` | TAL board draws for the first turn and mutates on a follow-up |
| `ai-tutor-tal-03` | P1 | 🔒 | teacher | `/dashboard` | Board maximize two-pane and rehydrate on reopen |
| `ai-tutor-tal-04` | P1 | 🔒 | teacher | `/dashboard` | Draw mode returns an animated whiteboard clip |
| `ai-tutor-tal-05` | P1 | 🔒 | parent | `/dashboard/children` | Parent opens coach on child's lesson: personalized greeting + recap, no raw chat |
| `ai-tutor-tal-06` | P1 | 🔒 | teacher | `/dashboard` | Read-aloud toggle controls spoken answers |
| `ai-tutor-tal-07` | P2 | 🔒 | teacher | `/dashboard` | Mic button transcribes speech into the question box |
| `ai-tutor-tal-08` | P0 | 🔒 | teacher | `/dashboard` | Not-ready lesson disables the coach with a clear message |
| `ai-tutor-tal-09` | P0 | 🔒 | teacher | `/dashboard` | Pro+ gate blocks a non-entitled lesson owner with an upgrade prompt |
| `ai-tutor-tal-10` | P0 | 🔒 | teacher | `/api/tutor` | Cross-tenant guard: coach refuses a lesson not assigned to the user |
| `ai-tutor-tal-11` | P1 | — | anon | `/api/tutor` | Unauthenticated request to tutor routes is rejected |
| `ai-tutor-tal-12` | P1 | 🔒 | teacher | `/dashboard` | Master flag OFF hides the coach entirely |
| `ai-tutor-tal-13` | P1 | 🔒 | teacher | `/dashboard` | Board declines a turn and gracefully falls back to a text answer |
| `ai-tutor-tal-14` | P2 | 🔒 | teacher | `/dashboard` | Sketch monthly cap returns a friendly limit message |
| `ai-tutor-tal-15` | P2 | 🔒 | teacher | `/api/tutor/board-token` | Canvas board-token endpoint is gated and scoped to the lesson |

<details><summary>Detailed steps & expected</summary>

**`ai-tutor-tal-01` — Teacher asks a text question and gets a grounded streamed answer** _(P0, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true and NEXT_PUBLIC_FEATURE_AI_TUTOR=true. Signed in as a teacher who OWNS at least one presentation lesson that finished generating (status done) and whose chapter has grounding indexed. FEATURE_AI_TUTOR_TAL and FEATURE_AI_TUTOR_SKETCH OFF so the plain text path is exercised.
- _Steps:_
  1. Open /dashboard and locate a completed presentation lesson row
  1. Click the '🎓 Assistant' link on that lesson to open the Ask Coach modal
  1. Confirm the header shows 'Ask Coach' with the chapter label, and a coach greeting bubble appears (not 'Coach unavailable')
  1. Type a question about the lesson (e.g. 'Explain the main idea of this chapter') in the input and click 'Ask'
  1. Watch the coach reply stream in token-by-token into a left-aligned bubble
- _Expect:_ A non-empty coach answer streams in and remains after completion; the input re-enables and refocuses; no error text (red) is shown.

**`ai-tutor-tal-02` — TAL board draws for the first turn and mutates on a follow-up** _(P0, teacher, flag: `FEATURE_AI_TUTOR_TAL`)_
- _Pre:_ FEATURE_AI_TUTOR=true, FEATURE_AI_TUTOR_TAL=true, NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=true (rebuilt client). Owner or assigned-student on a done presentation lesson with grounding. migration 0029/board tables present.
- _Steps:_
  1. Open the lesson and click '🎓 Assistant'
  1. Confirm the input placeholder reads 'Ask Coach to teach this on the board…'
  1. Ask a conceptual question and observe the persistent whiteboard (SVG) render objects with the new objects animating in, plus a narration transcript line below
  1. Ask a follow-up that builds on it (e.g. 'now add the next step')
  1. Confirm the SAME board mutates (prior objects stay static, only the newly-drawn objects animate) rather than a new board replacing it
- _Expect:_ First turn draws on the board with a spoken/transcript narration; the follow-up adds to the same board without wiping prior content; chat never shows a video clip while the board is on.

**`ai-tutor-tal-03` — Board maximize two-pane and rehydrate on reopen** _(P1, teacher, flag: `FEATURE_AI_TUTOR_TAL`)_
- _Pre:_ FEATURE_AI_TUTOR=true, FEATURE_AI_TUTOR_TAL=true, NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=true. A lesson where at least one board turn has already been drawn (run ai-tutor-tal-02 first so a board snapshot is persisted).
- _Steps:_
  1. Open Ask Coach on the lesson that already has a drawn board
  1. Click the maximize (🗖) control in the header
  1. Confirm the modal widens to a two-pane split: whiteboard on the left (~70%), chat on the right (~30%)
  1. Click restore (🗗) to return to the single-column layout
  1. Close the modal with × and reopen it via '🎓 Assistant'
  1. Confirm the previously-drawn board reappears rendered statically (no re-animation) from the server snapshot
- _Expect:_ Maximize toggles a 70/30 board+chat split; on reopen the existing board rehydrates from /api/tutor/turn GET and paints the prior scene without redrawing from scratch.

**`ai-tutor-tal-04` — Draw mode returns an animated whiteboard clip** _(P1, teacher, flag: `FEATURE_AI_TUTOR_SKETCH`)_
- _Pre:_ FEATURE_AI_TUTOR=true, FEATURE_AI_TUTOR_SKETCH=true, NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH=true, and FEATURE_AI_TUTOR_TAL OFF (Draw mode only applies when the board is off). Sketch-rendering worker deployed. Owner/assigned lesson with grounding, under the monthly sketch cap.
- _Steps:_
  1. Open Ask Coach; confirm a '✏️ Draw: on' toggle is visible in the header and the submit button reads 'Draw'
  1. Type a concept to illustrate (e.g. 'Draw the water cycle') and click 'Draw'
  1. Observe the placeholder '🖍️ Coach is drawing this out…' then the panel polling for the clip
  1. Wait for the rendered clip to arrive
- _Expect:_ Within ~2 minutes a playable <video> clip appears in the coach bubble with a 'Here's a quick sketch.' caption; a duplicate identical request replays instantly from the shared cache.

**`ai-tutor-tal-05` — Parent opens coach on child's lesson: personalized greeting + recap, no raw chat** _(P1, parent, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true, NEXT_PUBLIC_FEATURE_AI_TUTOR=true. Signed in as a VERIFIED parent (parent_links.verified_at set) whose child has a done presentation lesson assigned (student_progress row) with grounding.
- _Steps:_
  1. Open /dashboard/children and find the child card with an assigned presentation lesson
  1. Click 'Coach recap' and confirm it expands to show a mastery band chip, quiz % (if attempted), practice count, and 'Still shaky on' weak spots — and NO chat transcript
  1. Click '🎓 Assistant' on the same lesson
  1. Confirm the opening greeting is personalized to the child (names a weak spot when quiz evidence exists) and the recap widget is present inside the panel input bar
- _Expect:_ Recap shows aggregate mastery/quiz/practice/weak-spots only (privacy: no raw messages); the panel opens with a personalized greeting for the assigned student.

**`ai-tutor-tal-06` — Read-aloud toggle controls spoken answers** _(P1, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true, NEXT_PUBLIC_FEATURE_AI_TUTOR=true. Browser with speechSynthesis available. Owner/assigned lesson with grounding.
- _Steps:_
  1. Open Ask Coach; confirm the header shows '🔊 Read aloud' active by default
  1. Ask a question and confirm the completed answer is spoken aloud (browser voice)
  1. Click the toggle to '🔈 Read aloud' (off)
  1. Ask another question and confirm the new answer is NOT spoken
- _Expect:_ With read-aloud on, completed coach answers are voiced; toggling it off silences subsequent answers. Closing the panel cancels any in-progress speech.

**`ai-tutor-tal-07` — Mic button transcribes speech into the question box** _(P2, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true, NEXT_PUBLIC_FEATURE_AI_TUTOR=true. Browser that supports SpeechRecognition/webkitSpeechRecognition (mic button only renders when supported). Mic permission grantable.
- _Steps:_
  1. Open Ask Coach and confirm a 🎤 mic button appears left of the input (only when supported)
  1. Click the mic; confirm it enters a listening/pulsing state and the placeholder shows 'Listening…'
  1. Speak a short question
  1. Confirm the transcript populates the input field and listening stops (button returns to idle, input refocused)
- _Expect:_ Speech is transcribed into the input; the mic returns to idle on end. On an unsupported browser the mic button is simply absent (no error).

**`ai-tutor-tal-08` — Not-ready lesson disables the coach with a clear message** _(P0, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true, NEXT_PUBLIC_FEATURE_AI_TUTOR=true. A done presentation lesson whose chapter has NO grounding row (chapter_grounding missing), e.g. an older lesson generated before grounding was added.
- _Steps:_
  1. Open Ask Coach on the un-grounded lesson
  1. Observe the panel resolve readiness via GET /api/tutor
  1. Confirm the message "The coach isn't ready for this lesson yet." is shown
  1. Confirm the input placeholder reads 'Coach unavailable' and the input, mic, and Ask button are disabled
- _Expect:_ The panel reports the coach is not ready and blocks input entirely (no question can be submitted); no stream is attempted.

**`ai-tutor-tal-09` — Pro+ gate blocks a non-entitled lesson owner with an upgrade prompt** _(P0, teacher, flag: `FEATURE_AI_TUTOR_REQUIRE_PROPLUS`)_
- _Pre:_ FEATURE_AI_TUTOR=true, NEXT_PUBLIC_FEATURE_AI_TUTOR=true, and FEATURE_AI_TUTOR_REQUIRE_PROPLUS=true (post-trial enforcement). Signed in on a lesson whose OWNER has neither a Pro+/family plan nor a covering school entitlement.
- _Steps:_
  1. Open Ask Coach on the lesson
  1. Observe GET /api/tutor return the upgrade signal
  1. Confirm the panel shows "The AI Coach is a Pro+ feature — ask your teacher or parent to upgrade."
  1. Confirm the input is disabled and no question can be sent
  1. Optionally: directly POST /api/tutor for this generationId and confirm HTTP 403 with { upgrade: true }
- _Expect:_ Non-entitled owners are blocked with the Pro+ upgrade message and a disabled input; the server returns 403 upgrade for both GET readiness and POST/voice/sketch/turn routes.

**`ai-tutor-tal-10` — Cross-tenant guard: coach refuses a lesson not assigned to the user** _(P0, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true. Signed in as user B. Obtain a generationId that belongs to a DIFFERENT tenant/teacher A that B does not own, is not assigned to, and is not a verified parent of.
- _Steps:_
  1. Confirm user B does NOT see a '🎓 Assistant' button for teacher A's lesson anywhere in B's dashboard
  1. In the browser, navigate to /api/tutor?generationId=<teacherA_lesson_id>
  1. Confirm the JSON response is 403 with error "This lesson isn't assigned to you."
  1. Repeat a POST to /api/tutor/turn, /api/tutor/sketch, /api/tutor/voice, and /api/tutor/recap with the foreign id and confirm each returns 403 (not another user's data)
- _Expect:_ Every tutor route rejects a generationId the user has no owner/assigned-student/verified-parent relationship to with 403; no cross-tenant grounding, board, or recap data leaks.

**`ai-tutor-tal-11` — Unauthenticated request to tutor routes is rejected** _(P1, anon, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=true. No Supabase session (logged out / fresh browser).
- _Steps:_
  1. With no session, navigate to /api/tutor?generationId=<any_id>
  1. Confirm the response is 401 with error "Not signed in."
  1. Confirm the '🎓 Assistant' UI is unreachable because /dashboard redirects an anonymous visitor to login
- _Expect:_ All tutor API routes return 401 without a session; the coach UI is only reachable behind the authenticated dashboard.

**`ai-tutor-tal-12` — Master flag OFF hides the coach entirely** _(P1, teacher, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR=false / NEXT_PUBLIC_FEATURE_AI_TUTOR unset (default OFF). Signed in as a teacher with done presentation lessons.
- _Steps:_
  1. Open /dashboard and inspect the completed lesson rows
  1. Confirm NO '🎓 Assistant' button renders on any lesson (AskCoachButton returns null)
  1. Open /dashboard/children as a parent and confirm neither 'Coach recap' nor '🎓 Assistant' render
  1. Directly navigate to /api/tutor?generationId=<any_id> and confirm HTTP 404 "Not available."
- _Expect:_ With the master flag off the button is absent on every surface and all tutor routes 404 — nothing lights up by accident.

**`ai-tutor-tal-13` — Board declines a turn and gracefully falls back to a text answer** _(P1, teacher, flag: `FEATURE_AI_TUTOR_TAL`)_
- _Pre:_ FEATURE_AI_TUTOR=true, FEATURE_AI_TUTOR_TAL=true, NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=true. Craft a turn the board can't teach (e.g. an off-topic or non-visual question) so /api/tutor/turn returns { mode: 'text' }.
- _Steps:_
  1. Open Ask Coach (board mode) on a grounded lesson
  1. Ask a question the board can't render visually / that yields an invalid TAL program
  1. Confirm the '🖍️ Coach is teaching on the board…' placeholder is replaced
  1. Confirm the coach instead answers with a normal streamed TEXT reply in the chat (never a broken/blank board, never a video clip)
- _Expect:_ When the turn route returns mode:text, the panel clears the board placeholder and degrades to the standard /api/tutor text stream; the tutor is never left blank or errored.

**`ai-tutor-tal-14` — Sketch monthly cap returns a friendly limit message** _(P2, teacher, flag: `FEATURE_AI_TUTOR_SKETCH`)_
- _Pre:_ FEATURE_AI_TUTOR=true, FEATURE_AI_TUTOR_SKETCH=true, NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH=true. A test user already at/over SKETCH_MONTHLY_CAP for the current period (tutor_sketch_reserve returns false), or drive Draw requests until the cap is hit.
- _Steps:_
  1. Open Ask Coach with Draw mode on
  1. Request a NEW (uncached) sketch that must reserve a cap slot
  1. Confirm the coach bubble shows the limit message (server returns 429 "You've reached this month's sketch limit.")
  1. Confirm an already-cached identical sketch still replays for free (cache path bypasses the cap)
- _Expect:_ New sketch renders past the monthly cap are refused with the limit message; cached clips are unaffected. No infinite polling or hard crash.

**`ai-tutor-tal-15` — Canvas board-token endpoint is gated and scoped to the lesson** _(P2, teacher, flag: `FEATURE_AI_TUTOR_CANVAS`)_
- _Pre:_ Two configurations tested. (a) FEATURE_AI_TUTOR_CANVAS OFF: expect the mint route dark. (b) FEATURE_AI_TUTOR=true + FEATURE_AI_TUTOR_TAL=true + FEATURE_AI_TUTOR_CANVAS=true and BOARD_TOKEN_SECRET set: expect a token bound to (user, lesson). Owner/assigned lesson with grounding.
- _Steps:_
  1. With FEATURE_AI_TUTOR_CANVAS off, POST /api/tutor/board-token { generationId } and confirm HTTP 404 "Not available."
  1. Enable the canvas flag; POST the same for a lesson the user IS entitled to and confirm a { token, expiresIn } response
  1. POST board-token for a lesson NOT assigned to the user and confirm 403
  1. Confirm the minted token is rejected by /api/tutor/turn if presented as a Bearer for a DIFFERENT generationId (claims.gen mismatch → 401)
- _Expect:_ The board-token route only mints when the canvas flag is on and the caller passes the same assignment+Pro+ fence; tokens are bound to one lesson and can't be replayed against another.

</details>

### Analytics & school oversight  `analytics-school` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `analytics-school-01` | P0 | 🔒 | school_admin | `/dashboard/school` | Principal/admin sees whole-school health with aggregate-by-grade at-risk (no named minors) |
| `analytics-school-02` | P0 | 🔒 | coordinator | `/dashboard/school` | Coordinator sees named at-risk worklist scoped to their grade slice |
| `analytics-school-03` | P0 | 🔒 | student | `/dashboard/school` | Guard: student is redirected away from school analytics and has no School tab |
| `analytics-school-04` | P0 | 🔒 | teacher | `/dashboard/school` | Guard: plain teacher without a coordinator scope is blocked from school analytics |
| `analytics-school-05` | P0 | 🔒 | coordinator | `/dashboard/school/admin` | Guard: coordinator cannot reach the School Admin screen (redirects to /dashboard/school) |
| `analytics-school-06` | P1 | 🔒 | school_admin | `/dashboard/school/teachers` | Teachers layer loads with per-teacher activity, completion, and support flags vs cohort baseline |
| `analytics-school-07` | P1 | 🔒 | school_admin | `/dashboard/school/access` | Access-model page renders the role matrix and resolved footprints (admin) vs own slice (coordinator) |
| `analytics-school-08` | P1 | 🔒 | school_admin | `/dashboard/school/admin` | Admin grants a teacher coordinator access, adds/removes a scope, then revokes access |
| `analytics-school-09` | P1 | 🔒 | school_admin | `/dashboard/school/admin` | Access-audit trail records every leadership view of student data |
| `analytics-school-10` | P1 | 🔒 | teacher | `/dashboard/analytics` | My Analytics shows the 'What your school sees about your teaching' transparency block when the flag is on |
| `analytics-school-11` | P0 | 🔒 | coordinator | `/dashboard/school/access` | Cross-scope isolation: a coordinator sees only their own grade's students/teachers, nothing beyond |
| `analytics-school-12` | P1 | 🔒⚠️ | school_admin | `/dashboard/school/admin` | Admin resets a member's password from the roster and gets a one-time temp password |
| `analytics-school-13` | P2 | 🔒 | coordinator | `/dashboard/school` | Empty-state: clean scope shows 'no students flagged' and '—' for rates with no denominator |
| `analytics-school-14` | P2 | 🔒 | coordinator | `/dashboard/school` | Coordinator 'Contact parent' opens a prefilled email for a flagged student |
| `analytics-school-15` | P1 | 🔒 | any | `/dashboard` | Capability-based nav: leadership tabs appear per role (admin gets Admin, coordinator does not) |

<details><summary>Detailed steps & expected</summary>

**`analytics-school-01` — Principal/admin sees whole-school health with aggregate-by-grade at-risk (no named minors)** _(P0, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a school_admin with a seeded school that has classes, enrollments, shares, and some at-risk students.
- _Steps:_
  1. Sign in as the school_admin / principal account.
  1. Click the 'School' tab in the header (or navigate to /dashboard/school).
  1. Read the scope chip and the five metric tiles.
  1. Read the 'Students needing support' section body.
- _Expect:_ Page 'School analytics' loads with scope chip 'Whole school'; five tiles (Students, Active (14d), Completion, At-risk, Overdue) render with numeric values or '—'; the support section lists rows of the form 'Grade X — N at-risk' (aggregate) and NOT individual student names, plus the DPDP note about names only going to coordinators.

**`analytics-school-02` — Coordinator sees named at-risk worklist scoped to their grade slice** _(P0, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a teacher who holds coordinator_scope rows (e.g. Grade 5) with at least one flaggable student in that slice.
- _Steps:_
  1. Sign in as the teacher-with-scope (coordinator) account.
  1. Open /dashboard/school.
  1. Inspect the scope chip and the 'Students needing support' list.
  1. Confirm each flagged row shows the student name, class, reason chips, and (where a parent email exists) a 'Contact parent' button.
- _Expect:_ Scope chip reads e.g. 'Grade 5' (their grades, not 'Whole school'); the worklist is a NAMED list of students with reason chips (e.g. '40% completion', 'inactive 20d', '2 overdue') sorted most-reasons-first, and a 'Contact parent' action appears for students with a parent email.

**`analytics-school-03` — Guard: student is redirected away from school analytics and has no School tab** _(P0, student, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a student account.
- _Steps:_
  1. Sign in as a student.
  1. Confirm the header shows no 'School'/'Teachers'/'Access'/'Admin' tabs.
  1. Manually navigate to /dashboard/school in the address bar.
- _Expect:_ No leadership tabs render for the student; visiting /dashboard/school redirects to /dashboard (student never sees any school-wide or peer data).

**`analytics-school-04` — Guard: plain teacher without a coordinator scope is blocked from school analytics** _(P0, teacher, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a teacher who holds NO coordinator_scope rows and is not a school_admin.
- _Steps:_
  1. Sign in as a plain teacher (no scope grant).
  1. Confirm the header shows 'Library' and 'My Analytics' but no 'School'/'Teachers'/'Access' tabs.
  1. Manually navigate to /dashboard/school, then /dashboard/school/teachers.
- _Expect:_ The leadership tabs are absent for a scope-less teacher; direct navigation to /dashboard/school and /dashboard/school/teachers both redirect to /dashboard.

**`analytics-school-05` — Guard: coordinator cannot reach the School Admin screen (redirects to /dashboard/school)** _(P0, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a coordinator (teacher with scope) who is NOT a school_admin.
- _Steps:_
  1. Sign in as the coordinator account.
  1. Confirm the header shows School/Teachers/Access tabs but NOT an 'Admin' tab.
  1. Manually navigate to /dashboard/school/admin.
- _Expect:_ No 'Admin' tab for a non-admin; navigating to /dashboard/school/admin redirects the coordinator to /dashboard/school (scope-management stays admin-only).

**`analytics-school-06` — Teachers layer loads with per-teacher activity, completion, and support flags vs cohort baseline** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as school_admin with multiple teachers, some with grading backlog or below-baseline completion.
- _Steps:_
  1. Sign in as school_admin.
  1. Open the 'Teachers' tab (/dashboard/school/teachers).
  1. Read the intro line for the cohort baseline completion %.
  1. Inspect the teacher table columns (Lessons, Assigned, To grade, Completion) and any 'may need support' chips.
- _Expect:_ Page 'Teachers' lists each in-scope teacher with Lessons/Assigned/To grade/Completion values; the intro shows the cohort baseline completion %; teachers with a backlog or below-baseline completion show amber 'may need support' chips (e.g. '15pts below cohort', '4 to grade'); need-flagged teachers are ordered on top (framed as support, not a leaderboard).

**`analytics-school-07` — Access-model page renders the role matrix and resolved footprints (admin) vs own slice (coordinator)** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; at least one coordinator with a scope. Verify once as admin, once as coordinator.
- _Steps:_
  1. Sign in as school_admin and open the 'Access' tab (/dashboard/school/access).
  1. Confirm the 4-row 'who sees what' model table (Student/Teacher/Coordinator/Principal) renders.
  1. Confirm the 'Coordinators & their reach' section lists each coordinator with a resolved 'N classes · N students · N teachers' footprint and grade/subject chips.
  1. Sign out, sign in as a coordinator, reopen /dashboard/school/access, and confirm the 'Your access' section shows only their slice chips + coverage sentence.
- _Expect:_ Admin view shows the role matrix plus a per-coordinator footprint (class/student/teacher counts) with scope chips; coordinator view shows the same matrix plus 'Your access' with only their grade/subject chips and a sentence stating other grades are invisible to them.

**`analytics-school-08` — Admin grants a teacher coordinator access, adds/removes a scope, then revokes access** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as school_admin; at least one grade exists on a class and at least one grantable teacher exists. Use a disposable test teacher.
- _Steps:_
  1. Open /dashboard/school/admin.
  1. In 'Give a teacher coordinator access', choose a teacher, a grade, and (optionally) a subject, then click 'Grant access'.
  1. Confirm the teacher now appears under 'Coordinators & scopes' with a 'teacher & coordinator' chip and the granted grade chip.
  1. Use the per-coordinator '+ Add scope' to add a second grade, then click the '×' on one scope chip to remove it.
  1. Click 'Remove coordinator access' for that teacher.
- _Expect:_ Each action calls /api/coordinators and the list refreshes: granting adds the teacher as a coordinator with the scope chip; add/remove scope updates the chips live; a duplicate slice surfaces 'That grade/subject slice already exists.'; 'Remove coordinator access' clears all their grants and they drop back to the grantable list.

**`analytics-school-09` — Access-audit trail records every leadership view of student data** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on. Have a coordinator/principal view /dashboard/school and /dashboard/school/teachers first so log rows exist.
- _Steps:_
  1. As a coordinator or principal, open /dashboard/school and /dashboard/school/teachers to generate access events.
  1. Sign in as school_admin and open /dashboard/school/admin.
  1. Scroll to 'Access audit' and read the most recent rows.
- _Expect:_ The 'Access audit' list shows recent rows with the viewer's name and role, a scope chip ('at_risk' / 'school_health' / 'teacher_detail'), an 'N at-risk' count where applicable, and a timestamp — proving each leadership view was logged to analytics_access_log.

**`analytics-school-10` — My Analytics shows the 'What your school sees about your teaching' transparency block when the flag is on** _(P1, teacher, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as any adult (teacher) who has generated lessons and assignments.
- _Steps:_
  1. Sign in as a teacher and open the 'My Analytics' tab (/dashboard/analytics).
  1. Confirm the headline tiles (Classes, Students, Assignments, Completion, Overdue, To grade) render.
  1. Locate the grey 'What your school sees about your teaching' panel with the 'transparency' chip.
  1. Confirm 'By class', 'Most revised', and 'To grade' sections render below.
- _Expect:_ My Analytics loads with headline tiles, per-class completion bars, revision hotspots, and a grading queue; with the flag on, the transparency panel shows Lessons made / Assignments / Grading turnaround / To grade — the same activity metrics leadership sees — with the 'never a ranking' note.

**`analytics-school-11` — Cross-scope isolation: a coordinator sees only their own grade's students/teachers, nothing beyond** _(P0, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; school has at least two grades with distinct students/classes; coordinator scoped to exactly one grade.
- _Steps:_
  1. Sign in as the single-grade coordinator.
  1. Open /dashboard/school/access and read the 'Your access' coverage counts and the 'other grades invisible' sentence.
  1. Open /dashboard/school and confirm the worklist contains only students from their scoped grade.
  1. Open /dashboard/school/teachers and confirm only teachers of their scoped grade appear.
- _Expect:_ The coverage counts on the access page match only the coordinator's grade; the at-risk worklist and the Teachers table contain only in-slice students/teachers — no student, class, or teacher from other grades is ever shown (RLS scoping holds, not just UI hiding).

**`analytics-school-12` — Admin resets a member's password from the roster and gets a one-time temp password** _(P1, school_admin, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as school_admin; a DISPOSABLE test teacher/coordinator exists in the roster (this actually changes their password).
- _Steps:_
  1. Open /dashboard/school/admin and scroll to 'Members'.
  1. Click 'Reset password' next to the disposable test member.
  1. Confirm the inline 'Reset X's password?' prompt appears, then click 'Yes, reset'.
  1. Read the generated temporary password and the 'shown once' note; click 'Copy'.
- _Expect:_ The two-step confirm resets the member's password via /api/reset-password and displays a one-time temporary password (monospace) with a Copy button and '(shown once)'; the member will be forced to choose a new password at next sign-in. This is an irreversible credential change — only run against a throwaway account.

**`analytics-school-13` — Empty-state: clean scope shows 'no students flagged' and '—' for rates with no denominator** _(P2, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; logged in as a coordinator/admin whose scope currently has no at-risk students (and possibly nothing assigned yet).
- _Steps:_
  1. Sign in as a coordinator/admin with a clean or empty scope.
  1. Open /dashboard/school.
  1. Inspect the metric tiles and the 'Students needing support' section.
- _Expect:_ The support section shows the empty state 'No students flagged in this scope. 🎉'; Active/Completion tiles display '—' (not a misleading 0%) when there is no denominator yet, distinguishing no-data-yet from a measured zero.

**`analytics-school-14` — Coordinator 'Contact parent' opens a prefilled email for a flagged student** _(P2, coordinator, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; coordinator has at least one flagged student whose profile has a parent_email.
- _Steps:_
  1. Sign in as the coordinator and open /dashboard/school.
  1. Find a flagged student row that shows a 'Contact parent' button.
  1. Hover/click 'Contact parent' and inspect the resulting mailto target (without actually sending).
- _Expect:_ The 'Contact parent' link is a mailto: to the student's parent_email with a prefilled subject like 'Check-in about <student name>'; no email is sent by the click itself (it hands off to the mail client).

**`analytics-school-15` — Capability-based nav: leadership tabs appear per role (admin gets Admin, coordinator does not)** _(P1, any, flag: `FEATURE_SCHOOL_ANALYTICS`)_
- _Pre:_ FEATURE_SCHOOL_ANALYTICS on; test accounts available for school_admin, coordinator (teacher+scope), plain teacher, and student.
- _Steps:_
  1. Sign in as school_admin and note the header tabs.
  1. Sign in as a coordinator and note the header tabs.
  1. Sign in as a plain teacher and note the header tabs.
  1. Sign in as a student and note the header tabs.
- _Expect:_ school_admin sees Library, My Analytics, School, Teachers, Access, Admin (and Invites) with label 'admin & teacher'; coordinator sees School/Teachers/Access but NOT Admin, label 'teacher & coordinator'; plain teacher sees only Library + My Analytics; student sees no adult tabs — the nav renders the union of held capabilities only.

</details>

### Platform console (admin)  `console-admin` — 16 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `console-admin-01` | P0 | 🔒🔑 | platform_admin | `/console` | Platform staff signs in and lands on the console Overview |
| `console-admin-02` | P0 | 🔒 | teacher | `/console` | Non-staff user is bounced from the console to /dashboard |
| `console-admin-03` | P0 | — | anon | `/console` | Anonymous visitor cannot reach the console |
| `console-admin-04` | P1 | 🔒 | teacher | `/api/console/ops` | Console API routes return 404 (not 403) to non-staff — not probeable |
| `console-admin-05` | P1 | 🔒 | platform_admin | `/console` | Console tab navigation and active-tab highlight, plus '← App' exit |
| `console-admin-06` | P1 | 🔒 | platform_admin | `/console/users` | Users roster search filters by name / email / role / school |
| `console-admin-07` | P1 | 🔒 | platform_admin | `/console/users/[id]` | User detail page shows facts, badges, books, issue reports, and audit trail |
| `console-admin-08` | P1 | 🔒⚠️ | platform_admin | `/console/users/[id]` | Suspend then unsuspend a non-staff account (login ban + data cutoff) |
| `console-admin-09` | P1 | 🔒 | platform_admin | `/console/users/[id]` | Suspend is refused for staff targets and for self (footgun guard) |
| `console-admin-10` | P1 | 🔒 | platform_admin | `/console/users/[id]` | Set and clear per-account caps with validation |
| `console-admin-11` | P1 | 🔒 | platform_admin | `/console/users/[id]` | Founder-only staff grant/revoke; non-founder staff cannot mint staff |
| `console-admin-12` | P1 | 🔒⚠️ | platform_admin | `/console/content` | Content takedown hides a book from its owner (RLS), then restore returns it |
| `console-admin-13` | P1 | 🔒 | platform_admin | `/console/issues/[id]` | Triage an issue: change status/severity, add resolution note |
| `console-admin-14` | P2 | 🔒 | platform_admin | `/console/issues` | Issues queue status filters (Active hides resolved by default) |
| `console-admin-15` | P1 | 🔒 | platform_admin | `/console/users/[id]/view` | 'View as' read-only lens renders the user's world and is audited |
| `console-admin-16` | P1 | 🔒 | platform_admin | `/console/audit` | Audit tab reflects every staff write, newest-first and append-only |

<details><summary>Detailed steps & expected</summary>

**`console-admin-01` — Platform staff signs in and lands on the console Overview** _(P0, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ FEATURE_PLATFORM_CONSOLE=true; a founder account (email in FOUNDER_EMAILS) or an unrevoked platform_admins row exists. Human tester supplies the credentials.
- _Steps:_
  1. Human logs in as the founder/staff account (types the password).
  1. Navigate to /console.
  1. Observe the dark staff header band with tabs Overview/Issues/Users/Schools/Content/Feedback/Audit and the '<email> · staff' label.
  1. Confirm the Overview metrics grid renders (Schools, Teachers, Students, Admins, Signups 7d, Books, Job failure rate, Claude spend 30d), plus 'Generations by kind', 'Beta funnel', and 'Recent job errors' panels.
- _Expect:_ The distinct dark console shell loads at /console with the staff email shown; Overview metric cards, funnel bars, and job-error list all render without error (no redirect to /dashboard).

**`console-admin-02` — Non-staff user is bounced from the console to /dashboard** _(P0, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ FEATURE_PLATFORM_CONSOLE=true. Authenticated as an ordinary teacher (or school_admin/parent) whose email is NOT a founder and who has no platform_admins row. Human establishes the session.
- _Steps:_
  1. As a logged-in non-staff user, navigate directly to /console.
  1. Also try a deep link such as /console/users and /console/audit.
  1. Observe where the browser lands.
- _Expect:_ requirePlatformAdmin redirects every /console* URL to /dashboard; the user never sees the staff header, metrics, roster, or audit log (indistinguishable from a page that doesn't exist).

**`console-admin-03` — Anonymous visitor cannot reach the console** _(P0, anon, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ FEATURE_PLATFORM_CONSOLE=true. No authenticated session (fresh/incognito).
- _Steps:_
  1. With no session, navigate to /console.
  1. Follow any redirect.
- _Expect:_ The guard finds no user, redirects to /dashboard which in turn sends the visitor to the login page; no console content is ever exposed to an unauthenticated request.

**`console-admin-04` — Console API routes return 404 (not 403) to non-staff — not probeable** _(P1, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ FEATURE_PLATFORM_CONSOLE=true. Authenticated as a non-staff teacher; also repeat with no session.
- _Steps:_
  1. As a non-staff (or logged-out) session, issue a POST to /api/console/ops with a benign body like {"action":"set_caps","targetId":"<any-uuid>"} (use the browser devtools fetch).
  1. Issue a PATCH to /api/console/issues with {"id":"<any-uuid>","status":"open"}.
  1. Inspect the HTTP status and body of each response.
- _Expect:_ Both routes respond 404 with body {"error":"Not found."} — never 403 and never a mutation; a non-staff caller cannot tell the console endpoints exist, and no profile/issue is modified.

**`console-admin-05` — Console tab navigation and active-tab highlight, plus '← App' exit** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff (session from console-admin-01).
- _Steps:_
  1. From /console, click each header tab in turn: Issues, Users, Schools, Content, Feedback, Audit, then Overview.
  1. After each click confirm the URL matches (/console/issues, /console/users, …) and the clicked tab shows the active underline styling.
  1. Click the '← App' link in the top-right.
- _Expect:_ Each tab routes to its page and renders that section's heading; the current tab is highlighted (teal underline); '← App' returns to /dashboard.

**`console-admin-06` — Users roster search filters by name / email / role / school** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. At least a few accounts (teacher, student, school_admin) exist across schools.
- _Steps:_
  1. Go to /console/users; note the total account count and that rows list Name, Email/username, Role, School, Joined.
  1. Type a known teacher's name fragment into the search box and submit; confirm the URL gains ?q= and the list narrows to matches with the '… matching "q"' count.
  1. Search by a role word (e.g. 'student') and by a school name; confirm filtering.
  1. Search a nonsense string and confirm 'No matches.' is shown.
  1. Click a matching row.
- _Expect:_ Search filters the roster server-side across name/username/email/role/school; the count text updates; a non-matching query shows 'No matches.'; clicking a row opens /console/users/<id>.

**`console-admin-07` — User detail page shows facts, badges, books, issue reports, and audit trail** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. A target teacher account that owns at least one book and has reported an issue is ideal.
- _Steps:_
  1. Open a user from the roster.
  1. Confirm the facts card (Email, Username, Role, School, Joined, Classes, Books, Generations done/total).
  1. Confirm badges render as applicable: 'beta', 'suspended', 'staff'.
  1. Confirm the Books list, 'Issue reports' list (links to /console/issues/<id>), and 'Staff actions on this account' audit list appear when data exists.
  1. Confirm the 'View as (read-only)' button and the Ops panel are present.
- _Expect:_ The detail page renders the account's real profile facts and activity counts, correct badges, its books/issues/audit sub-lists, and the ops controls — all pulled cross-tenant via the service role.

**`console-admin-08` — Suspend then unsuspend a non-staff account (login ban + data cutoff)** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff (ideally a founder). Ops migrations 0015/0016 applied so opsReady is true. A disposable non-staff teacher target whose login the human can test.
- _Steps:_
  1. On a non-staff user's detail page, in the Ops panel click 'Suspend'.
  1. Confirm the button resolves and the page refreshes to show the red 'suspended' badge and the panel now reads 'Account suspended' with an 'Unsuspend' button.
  1. (Handoff) Human attempts to log in as the suspended user in a separate browser and confirms login is blocked / data access is cut.
  1. Back in the console, click 'Unsuspend' and confirm the badge clears and the panel returns to 'Suspend account'.
- _Expect:_ Suspend sets profiles.suspended_at and bans the auth user (login blocked, RLS cuts their data); the badge and panel reflect it and an audit row is written. Unsuspend fully reverses it. If the auth ban step fails the UI surfaces the amber 'login ban could not be set — retry' warning rather than hiding it.

**`console-admin-09` — Suspend is refused for staff targets and for self (footgun guard)** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. Ops migrations applied. Need a second staff/founder account as a target plus your own account.
- _Steps:_
  1. Open the detail page of another platform-staff (or founder) account.
  1. Confirm the Ops panel shows a 'staff — protected' chip instead of a Suspend button.
  1. Open your OWN account detail page and, via devtools, POST /api/console/ops {"action":"suspend","targetId":"<your-own-id>"}.
  1. POST the same against another staff account id.
- _Expect:_ The UI hides Suspend for staff targets; the API returns 400 'You can't suspend yourself.' for self and 400 'Target is platform staff — revoke that first.' for staff targets; no suspension occurs.

**`console-admin-10` — Set and clear per-account caps with validation** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. Ops migrations 0015/0016 applied (opsReady true). A non-staff teacher target.
- _Steps:_
  1. On a target's Ops panel, enter Books=3, Chapters=2, Students=5 and click 'Save caps'.
  1. Confirm the save succeeds (no error) and the values persist after the page refresh.
  1. Clear a field to blank and re-save; confirm blank resolves to default (null).
  1. Enter an invalid value (e.g. negative) and confirm the request is rejected with a validation error rather than saving.
  1. Confirm a 'cap_override' entry with before/after appears in the Audit tab.
- _Expect:_ Caps save via /api/console/ops and persist; blank = default(null); out-of-range values are rejected (0–100000 integer guard); every change is audited with before/after.

**`console-admin-11` — Founder-only staff grant/revoke; non-founder staff cannot mint staff** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a FOUNDER (email in FOUNDER_EMAILS). A non-student target account. Also a non-founder staff session for the negative check.
- _Steps:_
  1. As a founder, open a non-student user's detail page and confirm the 'Platform staff' section with a 'Make staff' button is visible.
  1. Click 'Make staff'; confirm the account gains the 'staff' badge and a platform_admins row (audit 'admin_grant').
  1. Click 'Revoke staff'; confirm the badge clears (audit 'admin_revoke').
  1. (Negative) As a NON-founder staff member, confirm the 'Platform staff' panel is absent, and a direct POST /api/console/ops {"action":"admin_grant",...} returns 403 'Founders only.'
- _Expect:_ Only founders see and can use grant/revoke; granting/revoking toggles the staff badge and writes audit rows; a non-founder staff member is blocked in the UI and gets 403 from the API.

**`console-admin-12` — Content takedown hides a book from its owner (RLS), then restore returns it** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. Migration 0015 applied (opsReady true). A teacher-owned book whose owner session the human can drive in a second browser.
- _Steps:_
  1. Go to /console/content; locate a target book in the Books list.
  1. Click 'Take down'; accept the confirm dialog ('It disappears for everyone (recoverable)').
  1. Confirm the row gains a red 'removed' badge and an audit entry is written.
  1. (Handoff) In the owning teacher's own session, confirm that book (and its generations/artifacts) no longer appears in their library and cannot be edited/deleted.
  1. Back in the console click 'Restore'; confirm the badge clears and the owner can see the book again.
- _Expect:_ Takedown soft-deletes via removed_at; RESTRICTIVE RLS makes the book vanish and freeze for the owner and all school-side users while staff still see it flagged 'removed'; restore reverses it. Nothing is hard-deleted and every action is audited.

**`console-admin-13` — Triage an issue: change status/severity, add resolution note** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. At least one reported issue exists in platform_issues (a portal user reported a problem, or seed one).
- _Steps:_
  1. Open /console/issues, click an open issue to open its detail page.
  1. Confirm the captured context (Page, Browser, recent job errors) and — if present — the AI diagnosis card render.
  1. In the Triage form set Status=resolved, Severity=high, type a resolution note, click 'Save'.
  1. Confirm the 'Saved.' confirmation, the Resolution card now showing the note + resolved timestamp, and an 'issue_status' before/after entry in the Audit tab.
  1. (Optional) Confirm the reporter sees only the status change, not the internal resolution note.
- _Expect:_ The PATCH updates status/severity/resolution_note and stamps resolved_at; the page reflects the new state, the change is audited with before/after, and the reporter is exposed to status only.

**`console-admin-14` — Issues queue status filters (Active hides resolved by default)** _(P2, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. A mix of open, in_progress, and resolved issues exists.
- _Steps:_
  1. Open /console/issues with no filter and confirm resolved issues are excluded (Active view).
  1. Click the 'Open', 'In progress', 'Resolved', and 'All' filter chips in turn.
  1. For each, confirm the URL ?status= param and that only matching issues (or all) are listed, high/critical severity chips show, and the active filter chip is highlighted.
- _Expect:_ Default view lists active (non-resolved) issues; each filter chip requeries by status and updates the list and the active-chip styling; 'All' includes resolved.

**`console-admin-15` — 'View as' read-only lens renders the user's world and is audited** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. A teacher target with books/classes and, separately, a student target with assigned work + scores.
- _Steps:_
  1. From a teacher's detail page click 'View as (read-only)'.
  1. Confirm the amber read-only banner ('nothing here is clickable, and this access is audited') and sections Books / Lessons & documents / Classes / Grading backlog with real counts.
  1. Confirm nothing in the sections is an interactive link (no session swap).
  1. Repeat 'View as' on a student account: confirm Classes and 'Assigned work' with status + score (e.g. 7/10) show, but NO submission answer bodies are exposed.
  1. Check the Audit tab for a 'view_as' entry naming the staff actor and target.
- _Expect:_ The lens server-renders exactly what the target owns/sees, read-only (no clickable/mutating controls); student views show progress and scores but never submission content; each open writes a 'view_as' audit row.

**`console-admin-16` — Audit tab reflects every staff write, newest-first and append-only** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as platform staff. Run after performing suspend/caps/takedown/issue-triage/view-as actions (scenarios 08,10,12,13,15).
- _Steps:_
  1. Open /console/audit.
  1. Confirm the actions taken in earlier scenarios appear (e.g. suspend, cap_override, takedown, restore, issue_status, view_as) with actor name, action, target kind, a detail snippet, and timestamp.
  1. Confirm ordering is newest-first and there is no delete/edit control (append-only).
- _Expect:_ The audit log lists each staff mutation with actor/action/target/detail/time, ordered newest-first, with no way to alter or remove entries — proving the ops trail is complete and immutable.

</details>

### Billing (Stripe + Lemon Squeezy)  `billing` — 14 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `billing-status-unauth-401` | P0 | — | anon | `/api/billing/status` | Billing status blocks unauthenticated callers |
| `billing-status-student-blocked` | P0 | 🔒 | student | `/api/billing/status` | Student account cannot read billing status |
| `billing-status-adult-gated` | P0 | 🔒 | teacher | `/api/billing/status` | Adult billing status reflects the BILLING_ENABLED gate |
| `billing-checkout-student-blocked` | P0 | 🔒 | student | `/api/billing/checkout` | Student cannot start a checkout session |
| `billing-checkout-school-happy` | P1 | 🔒🔑⚠️ | school_admin | `/api/billing/checkout` | School admin gets a Stripe (MYR) hosted checkout URL |
| `billing-checkout-teacher-ls-happy` | P1 | 🔒🔑⚠️ | teacher | `/api/billing/checkout` | Teacher plan routes to Lemon Squeezy (or clean 503 if unconfigured) |
| `billing-checkout-wrong-role-for-plan` | P1 | 🔒 | parent | `/api/billing/checkout` | Parent is refused a school-only plan |
| `billing-checkout-unknown-plan` | P1 | 🔒 | teacher | `/api/billing/checkout` | Unknown plan key is rejected |
| `billing-portal-happy` | P1 | 🔒 | school_admin | `/api/billing/portal` | Existing customer can open the self-service billing portal |
| `billing-portal-no-account-404` | P1 | 🔒 | teacher | `/api/billing/portal` | Portal returns 404 when the caller has no billing account |
| `billing-per-school-optout` | P2 | 🔒 | school_admin | `/api/billing/checkout` | Per-school billing opt-out blocks even when global billing is on |
| `billing-webhook-forged-event-rejected` | P2 | — | anon | `/api/webhooks/stripe` | Webhook receivers reject unsigned/forged events |
| `billing-ls-claim-on-signin` | P2 | 🔒🔑 | parent | `/api/billing/status` | Public-pricing-page purchase is claimed on first authenticated status read |
| `billing-checkout-cancel-return` | P2 | 🔒 | teacher | `/dashboard` | Canceling checkout returns the user cleanly to the dashboard |

<details><summary>Detailed steps & expected</summary>

**`billing-status-unauth-401` — Billing status blocks unauthenticated callers** _(P0, anon)_
- _Pre:_ No active session (logged out / incognito).
- _Steps:_
  1. Ensure you are logged out of app.sketchcast.app.
  1. Navigate directly to https://app.sketchcast.app/api/billing/status (a GET, so it is browser-navigable).
  1. Observe the HTTP status and JSON body.
- _Expect:_ Responds 401 with JSON {"error":"Not signed in."} — this runs before the role and BILLING_ENABLED checks, so it holds regardless of flag state.

**`billing-status-student-blocked` — Student account cannot read billing status** _(P0, student)_
- _Pre:_ Signed in as a student (non-adult role).
- _Steps:_
  1. Log in as a student account.
  1. Navigate to https://app.sketchcast.app/api/billing/status.
  1. Observe the status and body.
- _Expect:_ Responds 403 with {"error":"Billing is not available for this account."} (assertAdultRole runs before the BILLING_ENABLED flag, so a student is blocked even when billing is off).

**`billing-status-adult-gated` — Adult billing status reflects the BILLING_ENABLED gate** _(P0, teacher, flag: `BILLING_ENABLED`)_
- _Pre:_ Signed in as an adult (teacher/parent/school_admin/coordinator).
- _Steps:_
  1. Log in as an adult account.
  1. Navigate to https://app.sketchcast.app/api/billing/status.
  1. Observe the status and JSON body.
- _Expect:_ If BILLING_ENABLED is off (current prod default) → 403 {"error":"Billing isn't enabled yet."}. If BILLING_ENABLED is on → 200 with entitlement JSON {active, plan_key, status, current_period_end} (active:false for a user with no purchase).

**`billing-checkout-student-blocked` — Student cannot start a checkout session** _(P0, student)_
- _Pre:_ Signed in as a student.
- _Steps:_
  1. Log in as a student.
  1. From the app origin, issue POST /api/billing/checkout with a JSON body like {"planKey":"family_monthly"} (use the devtools/console fetch so the session cookie is sent).
  1. Observe the response.
- _Expect:_ Responds 403 {"error":"Billing is not available for this account."} — the adult-role guard runs before the flag, so no student can reach a payment provider. No checkout URL is ever returned.

**`billing-checkout-school-happy` — School admin gets a Stripe (MYR) hosted checkout URL** _(P1, school_admin, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true; Stripe keys + STRIPE_PRICE_SCHOOL_ANNUAL configured (MYR price). Signed in as a school_admin.
- _Steps:_
  1. Log in as a school_admin.
  1. POST /api/billing/checkout with {"planKey":"school_annual"} from the app origin.
  1. Read the returned {"url"}, then open it in the browser.
  1. STOP at the Stripe card-entry page — do NOT enter any card details; hand off to the human tester.
- _Expect:_ Returns 200 {"url": "..."} pointing at a Stripe-hosted checkout (checkout.stripe.com) that loads a card form priced in MYR. Completing the purchase (card entry + confirm) is left to the human.

**`billing-checkout-teacher-ls-happy` — Teacher plan routes to Lemon Squeezy (or clean 503 if unconfigured)** _(P1, teacher, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true. Signed in as a teacher/coordinator/school_admin. LS keys may or may not be configured (per current status, LS keys are pending).
- _Steps:_
  1. Log in as a teacher.
  1. POST /api/billing/checkout with {"planKey":"teacher_pro_monthly"}.
  1. Inspect the response; if a URL is returned, open it and STOP before any card entry.
- _Expect:_ If Lemon Squeezy is configured → 200 {"url"} to an LS-hosted checkout (*.lemonsqueezy.com, USD). If LS is not configured yet → 503 {"error":"This plan isn't available yet."}. No card is entered by the agent.

**`billing-checkout-wrong-role-for-plan` — Parent is refused a school-only plan** _(P1, parent, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true. Signed in as a parent.
- _Steps:_
  1. Log in as a parent.
  1. POST /api/billing/checkout with {"planKey":"school_annual"} (a Stripe school plan restricted to school_admin).
  1. Observe the response.
- _Expect:_ Responds 403 {"error":"This plan isn't available for your role."} and no checkout URL is created (plan.roles gate for school plans is school_admin only).

**`billing-checkout-unknown-plan` — Unknown plan key is rejected** _(P1, teacher, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true. Signed in as an adult.
- _Steps:_
  1. Log in as an adult.
  1. POST /api/billing/checkout with {"planKey":"does_not_exist"}.
  1. Also try an empty body and a non-JSON body to check input handling.
  1. Observe the responses.
- _Expect:_ Unknown/missing planKey → 400 {"error":"Unknown plan."}; a malformed (non-JSON) body → 400 {"error":"Invalid JSON."}. No checkout session is created.

**`billing-portal-happy` — Existing customer can open the self-service billing portal** _(P1, school_admin, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true. Signed in as an adult who already has a billing_customers row (a prior purchase / subscription).
- _Steps:_
  1. Log in as an adult who has previously purchased (has a billing account).
  1. POST /api/billing/portal (optionally {"provider":"stripe"} or {"provider":"lemonsqueezy"}).
  1. Open the returned {"url"} and confirm the provider's portal loads.
  1. Do NOT click Cancel subscription / change card — just confirm the portal opens for THIS caller's own account.
- _Expect:_ Returns 200 {"url"} to the correct provider portal (Stripe Billing Portal for school plans, LS Customer Portal for teacher/family), scoped to the caller's own customer. Opening it shows only the caller's own subscription — no other tenant's data.

**`billing-portal-no-account-404` — Portal returns 404 when the caller has no billing account** _(P1, teacher, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true. Signed in as an adult with NO prior purchase (no billing_customers row).
- _Steps:_
  1. Log in as an adult who has never purchased.
  1. POST /api/billing/portal.
  1. Observe the response.
- _Expect:_ Responds 404 {"error":"No billing account yet."} (and, if an LS-only caller with no subscription, {"error":"No subscription to manage yet."}). No portal URL is returned.

**`billing-per-school-optout` — Per-school billing opt-out blocks even when global billing is on** _(P2, school_admin, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true globally, but the caller's school has schools.billing_enabled=false. Signed in as a school_admin of that school.
- _Steps:_
  1. Log in as a school_admin belonging to a school whose billing_enabled is false.
  1. POST /api/billing/checkout with {"planKey":"school_annual"} (and also GET /api/billing/status).
  1. Observe the responses.
- _Expect:_ Both routes respond 403 {"error":"Billing isn't enabled for your school."} — the per-tenant opt-out overrides the global flag.

**`billing-webhook-forged-event-rejected` — Webhook receivers reject unsigned/forged events** _(P2, anon)_
- _Pre:_ Webhook secrets configured server-side. No valid provider signature available to the tester.
- _Steps:_
  1. POST an arbitrary JSON body to https://app.sketchcast.app/api/webhooks/stripe with no (or a bogus) stripe-signature header.
  1. Repeat against https://app.sketchcast.app/api/webhooks/lemonsqueezy with no (or a bogus) x-signature header.
  1. Observe the responses.
- _Expect:_ Both return 400 {"error":"Invalid signature."} and grant no entitlement — a forged event cannot unlock paid access. (If a secret env is missing the endpoint returns 500 'Not configured.' instead, which is also acceptable as a fail-closed signal.)

**`billing-ls-claim-on-signin` — Public-pricing-page purchase is claimed on first authenticated status read** _(P2, parent, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true, LS configured. A real Family purchase was made from the public sketchcast.app/pricing page using the tester's email (parked 'unclaimed'), and that email is verified on their app account.
- _Steps:_
  1. Complete a Family-plan purchase from the public pricing page with the tester's email (human-performed setup — real card).
  1. Log in to the app with that same verified email.
  1. Navigate to /api/billing/status.
  1. Confirm the parked subscription is bound and access is granted.
- _Expect:_ First authenticated status read claims the parked LS subscription and returns 200 with active:true for the Family plan; the entitlement did not exist until the verified-email sign-in. A mismatched/unverified email must NOT auto-grant.

**`billing-checkout-cancel-return` — Canceling checkout returns the user cleanly to the dashboard** _(P2, teacher, flag: `BILLING_ENABLED`)_
- _Pre:_ BILLING_ENABLED=true (and, for the teacher path, LS configured so a hosted page loads). Signed in as an adult.
- _Steps:_
  1. Log in as an adult and obtain a checkout URL via POST /api/billing/checkout (no card entered).
  1. Open the hosted checkout page, then use its back/cancel control to abandon the purchase.
  1. Observe the landing URL and page.
- _Expect:_ The user lands back at /dashboard?billing=canceled (parents at /dashboard/children?billing=canceled); the page loads normally with no error and no entitlement granted. (A successful purchase would instead return ?billing=success.)

</details>

### Student experience  `student-experience` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `student-login-username-01` | P0 | 🔑 | student | `/login` | Student signs in with their student ID (no email) |
| `student-first-run-reset-02` | P0 | 🔑 | student | `/auth/update-password` | Freshly provisioned student is forced to set a password on first sign-in |
| `student-reset-validation-03` | P1 | 🔒 | student | `/auth/update-password` | Password-change form rejects short and mismatched passwords |
| `student-reset-expired-link-04` | P2 | — | anon | `/auth/update-password` | Password-change page with no session shows the expired-link fallback |
| `student-dashboard-assigned-05` | P0 | 🔒 | student | `/dashboard` | Student sees only the lessons assigned to them, grouped by class and chapter |
| `student-empty-state-06` | P2 | 🔒 | student | `/dashboard` | Student with nothing assigned sees the empty state |
| `student-watch-complete-07` | P0 | 🔒 | student | `/dashboard` | Watching a lesson to the end marks it complete |
| `student-revise-completed-08` | P1 | 🔒 | student | `/dashboard` | Re-opening a completed lesson marks it Revised |
| `student-take-quiz-09` | P1 | 🔒 | student | `/dashboard` | Student takes an in-app quiz and it auto-grades on submit |
| `student-submit-file-10` | P1 | 🔒 | student | `/dashboard` | Student uploads an answer file for a worksheet |
| `student-nav-guard-11` | P1 | 🔒 | student | `/dashboard` | Student header exposes no adult/authoring tabs |
| `student-onboarding-exempt-12` | P1 | 🔒 | student | `/dashboard` | Student is never trapped in the Teacher/Parent onboarding gate |
| `student-ask-coach-access-13` | P1 | 🔒 | student | `/dashboard` | Ask Coach opens on an assigned lesson and answers only from it |
| `student-signout-14` | P1 | 🔒 | student | `/dashboard` | Student signs out and the session ends |
| `student-auth-guard-15` | P0 | — | anon | `/dashboard` | Signed-out visitor cannot reach the student dashboard |

<details><summary>Detailed steps & expected</summary>

**`student-login-username-01` — Student signs in with their student ID (no email)** _(P0, student)_
- _Pre:_ A provisioned student account exists whose must_reset_password flag is already cleared. Human tester supplies the student ID (e.g. aisha.khan) and password.
- _Steps:_
  1. Open /login
  1. In the 'Email or student ID' field type the student ID with no @ (e.g. aisha.khan)
  1. In 'Password' type the student's password
  1. Click 'Sign in'
- _Expect:_ The ID is mapped to <id>@students.sketchcast.app, sign-in succeeds, and the browser lands on /dashboard showing the 'My lessons' student view (not the teacher Library).

**`student-first-run-reset-02` — Freshly provisioned student is forced to set a password on first sign-in** _(P0, student)_
- _Pre:_ A just-provisioned student account with must_reset_password=true. Human tester supplies the student ID and the teacher-issued temp password, and picks a new password.
- _Steps:_
  1. Sign in at /login with the student ID and the temporary password
  1. Observe the app redirects away from /dashboard to /auth/update-password ('Choose a new password')
  1. Type a new password of at least 8 characters in both fields (matching)
  1. Click 'Set new password'
  1. After landing on the dashboard, reload the page
- _Expect:_ After saving, 'Password updated — taking you to your dashboard…' shows and the student reaches 'My lessons'. On reload they are NOT redirected back to /auth/update-password (must_reset_password was cleared).

**`student-reset-validation-03` — Password-change form rejects short and mismatched passwords** _(P1, student)_
- _Pre:_ An authenticated session on /auth/update-password (reached via the first-run redirect or a recovery link). Uses throwaway values, so no real credential is committed.
- _Steps:_
  1. On /auth/update-password enter 'abc' (under 8 chars) in both fields and click 'Set new password'
  1. Note the inline error
  1. Enter a valid 8+ char value in the first field and a different value in the second
  1. Click 'Set new password' again
- _Expect:_ First attempt shows 'Password must be at least 8 characters.'; the mismatched attempt shows "The two passwords don't match." Neither submits and no navigation occurs.

**`student-reset-expired-link-04` — Password-change page with no session shows the expired-link fallback** _(P2, anon)_
- _Pre:_ No authenticated session (signed out / fresh browser).
- _Steps:_
  1. While signed out, navigate directly to /auth/update-password
  1. Wait for the session check to resolve
- _Expect:_ The form does not render; instead the page shows "This link has expired or you're not signed in." with working links to 'Request a new reset link' (/login/forgot) and 'sign in' (/login).

**`student-dashboard-assigned-05` — Student sees only the lessons assigned to them, grouped by class and chapter** _(P0, student)_
- _Pre:_ A student enrolled in a class with at least one lesson and one worksheet/exam shared to them (via generation_shares).
- _Steps:_
  1. Sign in as the student and open /dashboard
  1. Read the page heading and the grouping structure
  1. Inspect each listed item's type label and status badge
- _Expect:_ Heading 'My lessons' with 'Everything your teacher has assigned to you.' Items appear grouped under a class chip and a chapter heading (real chapter title like 'Unit 1: …' or 'Chapter N'). Only assigned items appear — no library/authoring UI, and lesson_plan items are never shown. Direct parent shares group under 'From your parent'.

**`student-empty-state-06` — Student with nothing assigned sees the empty state** _(P2, student)_
- _Pre:_ A student account enrolled in a class but with no generation_shares assigned to them.
- _Steps:_
  1. Sign in as the un-assigned student and open /dashboard
  1. Read the main panel
- _Expect:_ The dashboard shows the dashed empty card: 'Nothing assigned yet. Check back after your teacher shares a lesson.' No class/chapter groups render.

**`student-watch-complete-07` — Watching a lesson to the end marks it complete** _(P0, student)_
- _Pre:_ Student has an assigned lesson (kind=presentation) with a rendered video artifact; its badge currently reads 'Not started'.
- _Steps:_
  1. On an assigned lesson row click '▶ Watch'
  1. Confirm the video modal opens and plays
  1. Let the video play to the very end (or seek to the end so onEnded fires)
  1. Close the modal and look at the row's badge
- _Expect:_ Opening the video flips the badge to 'In progress'; playing to the end flips it to '✓ Completed'. The status persists on reload (written to student_progress via the student's own session).

**`student-revise-completed-08` — Re-opening a completed lesson marks it Revised** _(P1, student)_
- _Pre:_ Student has a lesson already marked '✓ Completed'.
- _Steps:_
  1. On an already-completed lesson click '▶ Watch' to re-open it
  1. Close the modal and read the badge
  1. Re-open and close once more
- _Expect:_ The badge changes from '✓ Completed' to '↻ Revised' on re-open, and the internal revision count increments each additional open (revised_at/revision_count upsert).

**`student-take-quiz-09` — Student takes an in-app quiz and it auto-grades on submit** _(P1, student)_
- _Pre:_ Student has an assigned worksheet/exam whose worker emitted a questions.json (so a 'Take quiz' button shows).
- _Steps:_
  1. On a worksheet/exam row click 'Take quiz'
  1. In the QuizPlayer answer the objective questions (fill-in / true-false / match) and any subjective ones
  1. Click 'Submit answers'
  1. Read the row badge after the modal closes
- _Expect:_ The quiz modal renders questions by type; on submit objective answers are auto-scored, the submission is recorded, and the row badge flips to '✓ Completed'. If the quiz JSON is empty it instead shows 'Quiz unavailable — use Submit answer instead.'

**`student-submit-file-10` — Student uploads an answer file for a worksheet** _(P1, student)_
- _Pre:_ Student has an assigned worksheet/exam. Human tester supplies a small sample file to upload.
- _Steps:_
  1. On a worksheet/exam row click 'Submit file'
  1. Choose a small sample file (e.g. a PDF/image) in the file picker
  1. Wait for the 'Uploading…' state to finish
  1. Read the row badge and the button label
- _Expect:_ The file uploads to the submissions bucket, the badge flips to '✓ Completed', and the button now reads 'Resubmit' (upsert — re-uploading replaces, never destructive). On failure an error is surfaced instead of a false completion.

**`student-nav-guard-11` — Student header exposes no adult/authoring tabs** _(P1, student)_
- _Pre:_ Authenticated student session.
- _Steps:_
  1. On the student dashboard inspect the top app header
  1. Look for any of: Library, My Analytics, School, Teachers, Access, Admin, Invites, My Children, Test Papers
  1. Try navigating directly to /dashboard/analytics and /dashboard/school
- _Expect:_ The header shows only the logo, the student's name with '· student', a tour button and 'Sign out' — zero nav tabs (tabsFor returns [] for students). Direct visits to adult routes do not render authoring/analytics data for the student.

**`student-onboarding-exempt-12` — Student is never trapped in the Teacher/Parent onboarding gate** _(P1, student, flag: `FEATURE_ONBOARDING`)_
- _Pre:_ FEATURE_ONBOARDING enabled. An authenticated student session.
- _Steps:_
  1. With onboarding enabled, sign in as a student and open /dashboard
  1. Attempt to navigate directly to /onboarding
- _Expect:_ The student lands on their 'My lessons' dashboard and is not redirected to /onboarding, and the Teacher/Parent role picker is not forced on them (role==='student' is exempted from the blocking gate).

**`student-ask-coach-access-13` — Ask Coach opens on an assigned lesson and answers only from it** _(P1, student, flag: `FEATURE_AI_TUTOR`)_
- _Pre:_ FEATURE_AI_TUTOR (and NEXT_PUBLIC_FEATURE_AI_TUTOR) enabled. Student has an assigned lesson whose coach content is ready.
- _Steps:_
  1. On an assigned lesson click the '🎓 Assistant' button
  1. Wait for the Ask Coach panel to load its greeting
  1. Type a question about the lesson and send it
  1. Observe the streamed answer
- _Expect:_ The panel opens with a greeting and streams a grounded answer scoped to that lesson. For a lesson NOT assigned to the student the server returns 403 ("This lesson isn't assigned to you."); if Pro+ enforcement is on and the owner lacks entitlement it shows the upgrade message instead.

**`student-signout-14` — Student signs out and the session ends** _(P1, student)_
- _Pre:_ Authenticated student session.
- _Steps:_
  1. On the student dashboard click 'Sign out'
  1. After returning to the login screen, navigate directly to /dashboard
- _Expect:_ Sign-out returns the browser to /login; visiting /dashboard afterward redirects back to /login (no student content is shown while signed out).

**`student-auth-guard-15` — Signed-out visitor cannot reach the student dashboard** _(P0, anon)_
- _Pre:_ No authenticated session.
- _Steps:_
  1. In a fresh/signed-out browser navigate directly to /dashboard
  1. Observe where the app lands
- _Expect:_ The dashboard server component redirects an unauthenticated visitor to /login; no 'My lessons' content or another student's assignments are ever rendered without a session.

</details>

### Support & feedback  `support-feedback` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `support-report-problem-adult-01` | P1 | 🔒⚠️ | teacher | `/dashboard` | Adult files a tech-issue report via the bottom-left widget |
| `support-report-problem-student-minimized-02` | P1 | 🔒⚠️ | student | `/dashboard` | Student help widget is data-minimized (no free-text details) |
| `support-report-problem-validation-03` | P2 | 🔒 | teacher | `/dashboard` | Issue report rejects a too-short summary |
| `support-issue-rate-limit-04` | P2 | 🔒 | teacher | `/dashboard` | Sixth open issue report is rate-limited |
| `support-beta-feedback-submit-05` | P1 | 🔒⚠️ | teacher | `/dashboard` | Beta teacher submits the 4-star beta feedback form |
| `support-beta-feedback-validation-06` | P2 | 🔒 | teacher | `/dashboard` | Feedback form blocks submit until all four items are rated |
| `support-beta-feedback-already-submitted-07` | P2 | 🔒 | teacher | `/dashboard` | Already-submitted teacher sees received state, no form |
| `support-beta-feedback-gate-nonbeta-08` | P1 | 🔒 | any | `/dashboard` | Non-beta users never see the beta feedback widget |
| `support-content-diagnose-09` | P1 | 🔒⚠️ | teacher | `/dashboard` | Per-lesson 'Report an issue' triggers live AI diagnosis |
| `support-content-flag-hidden-10` | P2 | 🔒 | teacher | `/dashboard` | Content 'Report an issue' link is hidden when the flag is off |
| `support-content-dedupe-11` | P2 | 🔒 | teacher | `/dashboard` | Re-reporting the same lesson dedupes instead of re-diagnosing |
| `support-content-crosstenant-guard-12` | P1 | 🔒 | any | `/dashboard` | Content reporting is owner-scoped (no cross-tenant / student access) |
| `support-console-triage-13` | P1 | 🔒 | platform_admin | `/console/issues` | Staff triages a reported issue in the console |
| `support-console-guard-nonstaff-14` | P0 | 🔒 | teacher | `/console/issues` | Non-staff cannot reach the console or triage API |
| `support-console-feedback-view-15` | P2 | 🔒 | platform_admin | `/console/feedback` | Staff view beta feedback aggregates and legacy redirect |

<details><summary>Detailed steps & expected</summary>

**`support-report-problem-adult-01` — Adult files a tech-issue report via the bottom-left widget** _(P1, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as an adult (teacher/parent/coordinator/admin). FEATURE_PLATFORM_CONSOLE=true so the widget renders.
- _Steps:_
  1. Load /dashboard and locate the bottom-left 'Report a problem' button
  1. Click it to open the form
  1. Choose a category (e.g. 'Video lesson')
  1. Type a Summary of at least 4 characters (e.g. 'Deck download fails on Unit 3')
  1. Optionally type Details in the free-text textarea
  1. Click Send
- _Expect:_ Button shows 'Sending…' then 'Sent ✓', the form auto-closes after ~1.8s, and the report appears in the platform console Issues queue (server saves to platform_issues + emails the founder via Resend).

**`support-report-problem-student-minimized-02` — Student help widget is data-minimized (no free-text details)** _(P1, student, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a student (minor). FEATURE_PLATFORM_CONSOLE=true.
- _Steps:_
  1. Load the student /dashboard and find the bottom-left 'Need help?' button
  1. Open the form and confirm the header reads 'Something not working?'
  1. Verify only a category dropdown and a short 'What happened? (a few words)' input are present
  1. Confirm there is NO 'Details (optional)' textarea
  1. Pick a category, type a short summary, and Send
- _Expect:_ The student form exposes category + short title only (no free-text description field); submission succeeds and the stored report carries description=null (DPDP minimization for minors, enforced server-side too).

**`support-report-problem-validation-03` — Issue report rejects a too-short summary** _(P2, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as an adult. FEATURE_PLATFORM_CONSOLE=true.
- _Steps:_
  1. Open the bottom-left 'Report a problem' form
  1. Leave the Summary empty or type 1-3 characters
  1. Attempt to click Send
- _Expect:_ The browser blocks submission (required + minLength=4); if forced, the server returns 400 'Please describe the problem in a few words.' and no ticket is created.

**`support-issue-rate-limit-04` — Sixth open issue report is rate-limited** _(P2, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as an adult who already has 5 open/triaged/in_progress platform_issues. FEATURE_PLATFORM_CONSOLE=true.
- _Steps:_
  1. Open the 'Report a problem' form
  1. Pick a category, type a valid summary
  1. Click Send
- _Expect:_ Submission is refused with the 429 message 'You already have several open reports — we're on them!' and no additional ticket is filed.

**`support-beta-feedback-submit-05` — Beta teacher submits the 4-star beta feedback form** _(P1, teacher, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ Signed in as a beta_tester adult who has NOT yet submitted feedback. FEATURE_TEACHER_BETA=true.
- _Steps:_
  1. Load /dashboard and click the bottom-right 'Give feedback' button
  1. In the modal, select a 1-5 rating for all four items (Overall, Lesson quality, Deck quality, Ease of use)
  1. Optionally fill 'What worked well?' and 'What should we improve?'
  1. Click 'Send feedback'
- _Expect:_ The modal closes and the launcher becomes the pill '✓ Feedback received — thank you!'; a beta_feedback row is saved (single per teacher) and the founder is emailed. This is a one-time irreversible submission per account.

**`support-beta-feedback-validation-06` — Feedback form blocks submit until all four items are rated** _(P2, teacher, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ Signed in as a beta_tester adult who has not submitted. FEATURE_TEACHER_BETA=true.
- _Steps:_
  1. Click 'Give feedback' to open the modal
  1. Rate only some (not all) of the four items
  1. Click 'Send feedback'
- _Expect:_ Inline error 'Please rate all four items.' appears and no submission is sent (form stays open).

**`support-beta-feedback-already-submitted-07` — Already-submitted teacher sees received state, no form** _(P2, teacher, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ Signed in as a beta_tester who already submitted feedback (beta_feedback row exists). FEATURE_TEACHER_BETA=true.
- _Steps:_
  1. Load /dashboard
  1. Inspect the bottom-right feedback surface
- _Expect:_ The '✓ Feedback received — thank you!' pill is shown instead of the 'Give feedback' button; no feedback modal is available (single-submission enforced by the DB unique constraint, 409 maps to the same received state).

**`support-beta-feedback-gate-nonbeta-08` — Non-beta users never see the beta feedback widget** _(P1, any, flag: `FEATURE_TEACHER_BETA`)_
- _Pre:_ Signed in as a non-beta adult or a student. FEATURE_TEACHER_BETA=true.
- _Steps:_
  1. Load /dashboard as a non-beta account
  1. Confirm no bottom-right 'Give feedback' launcher appears
  1. (Optional API check) POST to /api/feedback with valid ratings
- _Expect:_ The feedback widget is absent for non-beta accounts; a direct POST /api/feedback returns 403 'Feedback is for beta teachers.' (students and non-beta accounts cannot consume a beta feedback slot).

**`support-content-diagnose-09` — Per-lesson 'Report an issue' triggers live AI diagnosis** _(P1, teacher, flag: `FEATURE_SUPPORT_AGENT`)_
- _Pre:_ Signed in as an adult who owns at least one generated lesson/paper. FEATURE_SUPPORT_AGENT / NEXT_PUBLIC_FEATURE_SUPPORT_AGENT=true and the diagnosis worker is running.
- _Steps:_
  1. On a lesson/paper content cell, click the 'Report an issue' link
  1. Select a category (e.g. 'Wrong chapter / different topic')
  1. Optionally add detail, then click 'Diagnose it'
  1. Watch the inline status line while it polls /api/support every 5s
- _Expect:_ Status progresses from 'Report received — starting diagnosis…' → pulsing 'Diagnosing…' → a settled outcome (e.g. 'Fixed — the correct chapter was regenerated', a self-heal retry, a user-fix suggestion, or honest escalation 'Flagged to the SketchCast team'); the page refreshes if a corrected item was produced. Queues an autonomous agent that may regenerate content and email the team.

**`support-content-flag-hidden-10` — Content 'Report an issue' link is hidden when the flag is off** _(P2, teacher, flag: `FEATURE_SUPPORT_AGENT`)_
- _Pre:_ Signed in as an adult owning lessons. NEXT_PUBLIC_FEATURE_SUPPORT_AGENT unset/false.
- _Steps:_
  1. Load /dashboard with lesson/paper content cells
  1. Inspect each content cell's action row
- _Expect:_ No per-lesson 'Report an issue' link renders (client component returns null); the /api/support route is also the real gate and returns 404 'Not enabled.' if called directly.

**`support-content-dedupe-11` — Re-reporting the same lesson dedupes instead of re-diagnosing** _(P2, teacher, flag: `FEATURE_SUPPORT_AGENT`)_
- _Pre:_ Signed in as owner of a lesson that already has an OPEN manual support report. FEATURE_SUPPORT_AGENT=true.
- _Steps:_
  1. On the same lesson cell, click 'Report an issue' again
  1. Pick a category and click 'Diagnose it'
- _Expect:_ The existing open issue is returned (deduped) — no second paid diagnosis run is farmed; the status line resumes the existing diagnosis rather than creating a new ticket.

**`support-content-crosstenant-guard-12` — Content reporting is owner-scoped (no cross-tenant / student access)** _(P1, any, flag: `FEATURE_SUPPORT_AGENT`)_
- _Pre:_ One account owns lesson G. A second adult (different tenant) and a student are available. FEATURE_SUPPORT_AGENT=true.
- _Steps:_
  1. As the second adult, POST /api/support with generationId=G (a lesson you do not own)
  1. As a student, POST /api/support with any generationId
- _Expect:_ A foreign generationId returns 404 'Lesson not found.' (owner_id gate — the agent can only be pointed at the reporter's own tenant data); a student caller returns 403 'Not available for student accounts.' No diagnosis job is queued in either case.

**`support-console-triage-13` — Staff triages a reported issue in the console** _(P1, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a platform admin (staff). FEATURE_PLATFORM_CONSOLE=true. At least one reported issue exists.
- _Steps:_
  1. Open /console/issues and confirm reported items list with status/severity chips
  1. Use the Active/Open/In progress/Resolved/All filters
  1. Click an issue to open its detail page
  1. Review Captured context (page, browser, recent job errors) and any AI diagnosis card
  1. In the Triage form set Status (e.g. in_progress or resolved), pick a Severity, add a resolution note, and click Save
- _Expect:_ 'Saved.' appears, the list/detail reflect the new status (resolving stamps resolved_at), and the change is written to the platform audit log. Reporter-visible status updates but the resolution note stays staff-only.

**`support-console-guard-nonstaff-14` — Non-staff cannot reach the console or triage API** _(P0, teacher, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a non-staff user (teacher/parent). FEATURE_PLATFORM_CONSOLE=true.
- _Steps:_
  1. Navigate directly to /console/issues
  1. Navigate directly to /console/issues/<any-id> and /console/feedback
  1. (Optional API check) send a PATCH to /api/console/issues
- _Expect:_ requirePlatformAdmin bounces the non-staff user to /dashboard for every /console page; the PATCH /api/console/issues returns 404 'Not found.' (the console must not be probeable). No issue is mutated.

**`support-console-feedback-view-15` — Staff view beta feedback aggregates and legacy redirect** _(P2, platform_admin, flag: `FEATURE_PLATFORM_CONSOLE`)_
- _Pre:_ Signed in as a platform admin. FEATURE_PLATFORM_CONSOLE=true. At least one beta_feedback submission exists.
- _Steps:_
  1. Open /console/feedback
  1. Confirm the four average-rating tiles and distribution bars render
  1. Confirm each submission card shows reporter name, per-item ratings, worked-well/improve text, trigger type, and usage context
  1. Navigate to the legacy /dashboard/beta-feedback URL
- _Expect:_ The Feedback page shows averages, distributions and individual submissions; /dashboard/beta-feedback redirects to /console/feedback (and re-guards, so a non-staff visitor lands back on their dashboard).

</details>

### Onboarding tour  `onboarding-tour` — 15 scenarios

| id | P | flags | role | path | title |
|---|---|---|---|---|---|
| `tour-teacher-autostart-01` | P0 | 🔒 | teacher | `/dashboard` | Teacher first-run tour auto-starts on the Library dashboard |
| `tour-teacher-complete-persist-02` | P0 | 🔒 | teacher | `/dashboard` | Completing the teacher tour persists seen-state and suppresses re-show |
| `tour-flag-off-absent-04` | P0 | 🔒 | any | `/dashboard` | With the feature flag off, the tour and replay button are entirely absent |
| `tour-student-role-correct-05` | P0 | 🔒 | student | `/dashboard` | A student sees the student tour, never the teacher tour |
| `tour-replay-button-03` | P1 | 🔒 | teacher | `/dashboard` | Header '🧭 Tour' button replays the tour on demand after completion |
| `tour-replay-navigates-homepath-06` | P1 | 🔒 | teacher | `/dashboard/analytics` | Replaying from a non-home route navigates to the tour's home screen first |
| `tour-parent-homepath-07` | P1 | 🔒 | parent | `/dashboard/children` | Parent tour auto-starts on My Children, not on the Library landing |
| `tour-skip-persist-08` | P1 | 🔒 | teacher | `/dashboard` | Closing (skipping) the tour records skipped and stops nagging this session |
| `tour-missing-target-graceful-09` | P1 | 🔒 | teacher | `/dashboard` | Empty-library teacher gets a shorter tour with no frozen/empty spotlight |
| `tour-analytics-events-fire-10` | P1 | 🔒 | teacher | `/dashboard` | Tour run emits the analytics beacon sequence to /api/tour/event |
| `tour-api-seen-guard-11` | P1 | 🔒 | any | `/api/tour/seen` | /api/tour/seen rejects unauthenticated and malformed writes |
| `tour-api-event-guard-12` | P1 | 🔒 | any | `/api/tour/event` | /api/tour/event enforces auth and the event-name whitelist |
| `tour-coordinator-centered-welcome-13` | P2 | 🔒 | coordinator | `/dashboard` | Coordinator tour opens with a centered welcome popover then points at the Tour button |
| `tour-school-admin-nav-targets-14` | P2 | 🔒 | school_admin | `/dashboard` | School-admin tour highlights the School nav tab, branding, book health and classes |
| `tour-version-bump-reshow-15` | P2 | 🔒 | teacher | `/dashboard` | A user whose stored tour version is older re-sees the improved tour |

<details><summary>Detailed steps & expected</summary>

**`tour-teacher-autostart-01` — Teacher first-run tour auto-starts on the Library dashboard** _(P0, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Onboarded teacher session with at least one book in the library and NO existing user_tour_progress row for teacher_onboarding (never seen the tour). Migration 0037 applied. NEXT_PUBLIC_FEATURE_TOUR=true.
- _Steps:_
  1. Sign in as the teacher and land on /dashboard
  1. Wait ~1 second for hydration to settle without clicking anything
  1. Observe the first coach-mark spotlight appear over the book library
  1. Read the tooltip title and body
- _Expect:_ A driver.js spotlight dims the page and highlights the library area with a tooltip titled 'Your library'. A step progress indicator (e.g. '1 of N') and Next/Done buttons are shown. The tour was not triggered by any click.

**`tour-teacher-complete-persist-02` — Completing the teacher tour persists seen-state and suppresses re-show** _(P0, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Same teacher as tour-teacher-autostart-01, tour currently auto-started (or unseen). Flag on.
- _Steps:_
  1. With the tour open on /dashboard, click Next repeatedly to advance through every step
  1. On the final step click Done to close the tour
  1. Observe the spotlight/overlay disappears and the page is fully interactive
  1. Reload /dashboard and wait ~1 second
- _Expect:_ The tour advances step by step and closes on Done. After reload the tour does NOT auto-start again (a user_tour_progress row status=completed was written, so shouldAutoStart returns false). The '🧭 Tour' button remains in the header.

**`tour-flag-off-absent-04` — With the feature flag off, the tour and replay button are entirely absent** _(P0, any, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ A build/deploy where NEXT_PUBLIC_FEATURE_TOUR is NOT 'true' (dark-launch default). Any adult role session.
- _Steps:_
  1. Sign in and land on /dashboard
  1. Wait ~2 seconds and confirm no coach-mark spotlight appears
  1. Scan the header account controls for a 'Tour' button
- _Expect:_ No auto-start occurs and no spotlight is ever shown. The '🧭 Tour' replay button is not rendered anywhere in the header (dark-launch safe).

**`tour-student-role-correct-05` — A student sees the student tour, never the teacher tour** _(P0, student, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Student session that has never seen student_onboarding, with at least one assignment visible. Flag on.
- _Steps:_
  1. Sign in as the student and land on /dashboard
  1. Wait for the tour to auto-start
  1. Read the first tooltip title/body and note the total step count
- _Expect:_ The STUDENT tour runs: first step titled 'Your work' pointing at the assignments area, and the flow contains student-only steps (open a lesson, Ask the Assistant, Your progress) — the teacher steps (generate lesson, assign to a class, classes) are never shown. Students also have no header nav tabs.

**`tour-replay-button-03` — Header '🧭 Tour' button replays the tour on demand after completion** _(P1, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Teacher who has ALREADY completed the tour (auto-start suppressed). Flag on. Currently on /dashboard.
- _Steps:_
  1. Confirm no tour auto-starts on load
  1. Click the '🧭 Tour' button in the header (aria-label 'Take a tour')
  1. Observe the tour begin
  1. Advance one step with Next
- _Expect:_ Clicking the button force-starts the tour again even though it was previously completed; the first spotlight appears and Next advances normally. Replay does not require clearing seen-state.

**`tour-replay-navigates-homepath-06` — Replaying from a non-home route navigates to the tour's home screen first** _(P1, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Teacher session, flag on. Navigate to /dashboard/analytics (not the tour homePath /dashboard).
- _Steps:_
  1. From /dashboard/analytics click the '🧭 Tour' button
  1. Observe the app navigate
  1. Wait ~1 second and watch for the tour
- _Expect:_ The app navigates to /dashboard (the teacher tour's homePath) and then the tour auto-starts there (~400ms after arrival), rather than trying to spotlight elements that don't exist on the analytics page.

**`tour-parent-homepath-07` — Parent tour auto-starts on My Children, not on the Library landing** _(P1, parent, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Parent session that has never seen parent_onboarding and has at least one linked child. Flag on. Note: parents land on /dashboard (Library) after login.
- _Steps:_
  1. Sign in as the parent and land on /dashboard (Library)
  1. Wait ~2 seconds and confirm NO tour auto-starts on the Library page
  1. Click the 'My Children' nav tab to go to /dashboard/children
  1. Wait ~1 second
- _Expect:_ No spotlight on /dashboard because it is not the parent tour's homePath. After navigating to /dashboard/children the parent tour auto-starts with the first step 'Your child's work' highlighting the child assignments card.

**`tour-skip-persist-08` — Closing (skipping) the tour records skipped and stops nagging this session** _(P1, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Teacher who has never seen the tour; tour auto-started. Flag on.
- _Steps:_
  1. With the tour open, click the close (X) control or press Escape on the first or second step
  1. Confirm the overlay disappears
  1. Reload /dashboard and wait ~2 seconds
- _Expect:_ The tour closes immediately. A user_tour_progress row status=skipped is written and a tour_skipped analytics event is sent. On reload the tour does not auto-start again this session/version. The '🧭 Tour' button remains available to restart manually.

**`tour-missing-target-graceful-09` — Empty-library teacher gets a shorter tour with no frozen/empty spotlight** _(P1, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Brand-new teacher with an EMPTY library (no books → generate-lesson / lesson-output / assign-chapter markers not yet rendered) and never seen the tour. Flag on.
- _Steps:_
  1. Sign in as the new empty-library teacher and land on /dashboard
  1. Let the tour auto-start
  1. Step through the whole tour with Next to the end
  1. Watch each spotlight for any that highlights nothing / floats over empty space
- _Expect:_ The tour runs only the steps whose targets exist (e.g. library/assistant/classes) and silently skips the missing generate/output/assign steps — never a frozen or empty spotlight. Skipped steps are logged as tour_step_target_missing. The tour still completes cleanly.

**`tour-analytics-events-fire-10` — Tour run emits the analytics beacon sequence to /api/tour/event** _(P1, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Teacher session, flag on, with network inspection available in the QA browser.
- _Steps:_
  1. Open the browser network panel and filter for /api/tour/event
  1. Trigger the tour (auto-start or the '🧭 Tour' button)
  1. Advance through several steps with Next, then finish with Done
  1. Inspect the recorded POST requests to /api/tour/event
- _Expect:_ POSTs (sendBeacon) to /api/tour/event fire for tour_started, then tour_step_viewed for each shown step, then tour_completed — each carrying tourKey, role and version. Requests return 2xx. No event is blocked by the app and telemetry never throws into the UI.

**`tour-api-seen-guard-11` — /api/tour/seen rejects unauthenticated and malformed writes** _(P1, any)_
- _Pre:_ Ability to issue HTTP POSTs. Test the 401 path with no session cookie; test the 400 path with a valid authenticated session.
- _Steps:_
  1. POST /api/tour/seen with no auth cookie and a valid JSON body → expect 401
  1. With an authenticated session, POST an invalid body (missing tourKey, or status other than completed/skipped) → expect 400
  1. With an authenticated session, POST a valid body {tourKey, version, status:'completed'} → expect 200
  1. Confirm the response never lets you set another user's user_id (RLS pins user_id to caller)
- _Expect:_ Unauthenticated POST returns 401 {ok:false}. Malformed/invalid-status body returns 400. Valid body returns 200 and upserts only the caller's row (user_id cannot be spoofed via body — it comes from the session, enforced by RLS).

**`tour-api-event-guard-12` — /api/tour/event enforces auth and the event-name whitelist** _(P1, any)_
- _Pre:_ Ability to issue HTTP POSTs. Authenticated session available for the whitelist checks.
- _Steps:_
  1. POST /api/tour/event with no auth cookie → expect 401
  1. With a session, POST {event:'not_a_real_event', tourKey:'teacher_onboarding'} → expect 400
  1. With a session, POST a valid whitelisted event with an empty tourKey → expect 400
  1. With a session, POST {event:'tour_started', tourKey:'teacher_onboarding', version:1, role:'teacher'} → expect 200
- _Expect:_ Unauthenticated returns 401. Events outside the whitelist (tour_started/tour_step_viewed/tour_skipped/tour_step_target_missing/tour_completed) or missing tourKey return 400. Valid whitelisted event returns 200 and is stored with user_id taken from the session (not the body).

**`tour-coordinator-centered-welcome-13` — Coordinator tour opens with a centered welcome popover then points at the Tour button** _(P2, coordinator, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ Coordinator session that has never seen coordinator_onboarding. Flag on.
- _Steps:_
  1. Sign in as the coordinator and land on /dashboard
  1. Let the tour auto-start
  1. Observe the first popover position (centered, no element highlighted)
  1. Advance with Next through the remaining steps
- _Expect:_ Step 1 is a centered popover titled 'Welcome to SketchCast' with no spotlighted element (target is empty by design). Subsequent steps highlight the classes area and finally the '🧭 Tour' replay button ('Need a hand?'). No step floats over empty space.

**`tour-school-admin-nav-targets-14` — School-admin tour highlights the School nav tab, branding, book health and classes** _(P2, school_admin, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ School_admin session that has never seen school_admin_onboarding, with the School nav visible (schoolAnalyticsEnabled) and at least one book showing a health badge. Flag on.
- _Steps:_
  1. Sign in as the school admin and land on /dashboard
  1. Let the tour auto-start
  1. Step through with Next and note which element each step spotlights
- _Expect:_ The tour spotlights, in order, the 'School' header nav tab (data-tour school-nav), the branding section, a book-health badge, then the classes area — matching the school_admin definition. If the School tab is absent (analytics flag off) that step is skipped gracefully rather than spotlighting nothing.

**`tour-version-bump-reshow-15` — A user whose stored tour version is older re-sees the improved tour** _(P2, teacher, flag: `NEXT_PUBLIC_FEATURE_TOUR`)_
- _Pre:_ DB/human setup: a teacher with a user_tour_progress row for teacher_onboarding whose stored version is LOWER than the current definition version (simulates a version bump). Flag on. Requires a data seed, not doable by the browser agent alone.
- _Steps:_
  1. Ensure the teacher's stored tour version < current definition version
  1. Sign in as that teacher and land on /dashboard
  1. Wait ~1 second
- _Expect:_ Even though the teacher previously completed/skipped the tour, it auto-starts again because shouldAutoStart returns true when stored version < current. A teacher already at the current version would NOT be re-shown.

</details>

---

## Coverage gaps (add these by hand)

Flagged by the synthesis pass as not covered by any area mapper — worth adding as you go:

- Session lifecycle: no scenario covers JWT/session expiry mid-action, silent token refresh, or a suspended user (console-admin-08) being force-logged-out and cut off mid-session rather than just banned at next login.
- Email deliverability is asserted only as 'a link is sent' (auth-08, invites). No scenario verifies actual receipt, link validity end-to-end, or Resend/SMTP failure handling.
- Billing success path is untested: forged webhooks are rejected (billing-webhook-forged) and checkout URLs are created, but no scenario verifies that a completed Stripe/Lemon-Squeezy payment actually flips entitlements on the shared entitlements table.
- Login abuse: only a single wrong-password rejection (auth-02) is covered; no rate-limiting / lockout / brute-force protection scenario on login or forgot-password enumeration under repeated attempts.
- parent-portal-reset-child-password-08 is flagged only [auth] while every other password-reset flow (classes-09, analytics-12, auth-13) is [destructive/secret]; the one-time temp-password display and its destructive nature appear under-classified and its temp-secret handling is unverified.
- Large / pathological uploads: no scenario for very large or slow-to-index textbook PDFs (the known storage/index timeout gotcha), nor malicious/wrong-type file rejection on student answer upload (student-submit-10) or branding templates (library-12).
- Media fallback: TTS/voice provider outage (ElevenLabs/read-aloud) and video/deck playback failure fallbacks are not exercised anywhere despite read-aloud and narrated-lesson features.
- Conversation memory: Ask Coach / assistant 30-day history persistence and rehydration across separate sessions is not directly tested (only in-session board rehydrate, ai-tutor-tal-03).
- Browser resilience: no back-button / refresh / double-submit integrity checks after long mutations (generate, assign, provision, checkout return), and no offline/network-loss behavior.
- Feature-flag interactions: individual flag-on and flag-off states are covered, but combined/partial flag states (e.g., portal on but billing off, tour version bump plus onboarding gate) are not.
- Data-subject flows: no account-deletion, data-export, or GDPR/consent-withdrawal path for minors, despite the parent/student minor-data sensitivity.
- Coordinator 'Contact parent' (analytics-14) verifies a prefilled email opens, but the no-email-on-file / malformed-recipient edge and that nothing is auto-sent are not covered.

---

_Generated 2026-07-12 from a 13-area code sweep. To rebuild after feature changes, re-run the
`qa-catalog-build` workflow and regenerate this file._
