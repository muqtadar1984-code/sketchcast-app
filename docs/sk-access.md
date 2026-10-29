# SK access: the restricted-live allow-list

The founder's request (2026-10-30): "ensure that SK is accessible by only
muqtadar1984@gmail.com, junaidisara8@gmail.com and her students till I pass
the test and clear for live release." Here "her students" means the students
in Sara's (junaidisara8@gmail.com) classes only. It does not include the
founder's own students.

## The gate

`skAccessAllowed(user, profile?)` in `src/utils/flags.ts` is the one gate. It
returns true when any of these holds:

1. No allow-list is in force: `SK_ALLOWED_EMAILS` and `SK_ALLOWED_STUDENTS_OF`
   are both unset or empty. This is the behaviour from before the allow-list,
   where `FEATURE_SK` and the other flags decide on their own.
2. The user's **verified** address is on `SK_ALLOWED_EMAILS`.
3. The user is **currently enrolled** in a class whose `teacher_id` is the
   profile of a **verified** auth user whose address is on
   `SK_ALLOWED_STUDENTS_OF`. The student's own address is not checked, so a
   teacher-created account with no email, or an unverified one, still passes.
   The lookup in `src/sk/access-gate.ts` uses the service role. It caches the
   teacher ids and their class ids for 60 s per server instance. It never
   caches enrollments, so a student who is removed from the class loses SK on
   their next request.

If the lookup fails (auth, classes, enrollments, or a missing service key), the
user is **not allowed** and the error is logged as `[sk-access]`. Both
variables are server-only and must never be set as `NEXT_PUBLIC_*`. A boundary
test enforces this.

A user the gate refuses gets the same result as before the allow-list:

- **API routes:** a 404 on `/api/sk/*`.
- **Pages:** a 404 on `/sk`, `/sk/<product>`, `/sk/<product>/<chapter>` and
  `/activate`.
- **Navigation:** no SK Tutor tab and no Shell launcher on the dashboard,
  console, `/sk` or the Board.

### Where each entry point is gated

| Entry point | How |
|---|---|
| `/api/sk/{session,session/[id],turn,answer,command,kit,kit/items,kit/answer,kit/turn,speak,stt/url}` | `gate()` in `src/sk/server.ts` calls `skAccessAllowed` |
| `/api/sk/{shell/context,shell/tray,shell/turn,act,manifest}` | `skShellEnabledFor` calls `skAccessAllowed`, then checks the role and tenant |
| `/api/sk/{redeem,activate}` | `skAccessAllowed` runs before the `BOOK_CODE_SECRET` 503 |
| `/sk`, `/sk/[product]`, `/sk/[product]/[chapter]`, `/activate` | `skAccessAllowed` returns false, so the page calls `notFound()` |
| Dashboard, console and Board Shell launcher; `/sk` layout | `skShellEnabledFor` / `skTutorShellEnabledFor` |
| SK Tutor tab (`app-header.tsx`, the Board's tab row) | `skAccessAllowed(user, { role })` |
| `/api/sk/{memory,consent,prefs,school-memory}` | Exempt on purpose: these are the controls on `/dashboard/settings`, which every signed-in user sees. Deleting your SK memory and revoking a child's consent must always work. None of them serves SK content or calls a model. |

`src/app/api/sk/__tests__/access-gate-routes.test.ts` walks every `route.ts`
under `src/app/api/sk` and checks that each one refuses a refused user. A new
route therefore fails that test until it is gated or added to the exemption
list with a stated reason.

The Shell still has its own role gate. `SK_ROLES` must include `student` before
students see the Shell launcher. An allowed user skips the per-school opt-in,
just as allow-listed adults always have.

## The values for the founder's request (Vercel, Production)

```
SK_ALLOWED_EMAILS=muqtadar1984@gmail.com,junaidisara8@gmail.com
SK_ALLOWED_STUDENTS_OF=junaidisara8@gmail.com
SK_ROLES=teacher,student
```

Keep `FEATURE_SK=true` and `NEXT_PUBLIC_FEATURE_SK=true` as they are.
Environment changes take effect on the next deployment.

Production check (2026-10-30, SELECT only):

- Both teacher accounts are verified.
- Sara teaches 1 class, which has 1 enrolled student (`566d0e1f…`, role
  `student`). That student is the only one admitted through Sara.
- The founder teaches 3 classes with 9 students. None of them is in the set
  admitted through Sara.

To add another tester or teacher later, append their address to the relevant
list. A teacher on `SK_ALLOWED_STUDENTS_OF` must also be on `SK_ALLOWED_EMAILS`
to use SK themselves.

## Opening up at release

Once the founder clears SK for live release:

1. **Delete** both `SK_ALLOWED_EMAILS` and `SK_ALLOWED_STUDENTS_OF` in Vercel.
   Setting them to an empty value also works, because empty means the list is
   not in force. Leaving either one set keeps SK restricted.
2. Set `SK_ROLES` to the roles that should get the Shell.
3. Decide on the tenant opt-in. Without the allow-list, a school user gets the
   Shell only when `schools.config.sk_shell = true` or
   `FEATURE_SK_SHELL_ALL_SCHOOLS=true`. A user with no school needs
   `SK_SHELL_CONSUMER=true`.
4. Redeploy.

To roll back, set the lists again and redeploy.
