# SK book codes: switching activation on and testing it (founder steps)

This covers SK S4 slice D (book activation for a chosen child). Until step 1 is done, `/activate` and SK both say "Book codes aren't switched on yet." Production has no codes yet.

## 1. Set `BOOK_CODE_SECRET` (once, never change it)

Every code's HMAC in the database is computed with this secret. If you change it later, every printed code stops working. Store it in your password manager.

Generate one (Windows, no openssl needed):

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

That prints 32 characters; anything of 16 or more works. Then:

- **Vercel** (app project), Production: add `BOOK_CODE_SECRET` = that value and redeploy (an env change takes effect only on a new deploy).
- It is also the fallback for `SK_SHELL_SECRET` (action tokens and SK's conversation memory). If `SK_SHELL_SECRET` is unset, setting this signs those too. That's harmless: any open confirmation cards simply expire.

## 2. Mint ONE test edition code (you run this; it writes to production)

The tool is `tools/sk/make-edition-code.ts`. It prints the plain code once and, with `--insert`, stores only its HMAC in `edition_codes`. Run it from the app repo root in PowerShell, with the same secret as Vercel:

```powershell
$env:BOOK_CODE_SECRET = "<the value from step 1>"
$env:SUPABASE_URL = "https://pblaxsqhjwlqbrwbraxy.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key from Supabase → Project settings → API>"
npx tsx tools/sk/make-edition-code.ts --product 161828e0-32aa-40df-bbf3-16eb32c82504 --edition test-2026-10 --cap 5 --insert
```

- `161828e0-32aa-40df-bbf3-16eb32c82504` is the only product on production: "Biology: Cells - Structure, Function and Organisation" (approved).
- `--edition test-2026-10` keeps the test code separate from the real KDP edition: `(product, edition)` is unique, so the real `kdp-…` edition is still free.
- `--cap 5` allows 5 activations per rolling 24 hours.
- `npx` may ask to download `tsx` the first time. Answer `y`.
- Copy the printed `SKE-XXXX-XXXX-XXXX-XXXXX`. It is shown once and is never stored in clear.

## 3. Test as a parent for a child

**You need:**
- a parent account on `SK_ALLOWED_EMAILS` (a verified address);
- one VERIFIED linked child: My children shows the child; `parent_links.verified_at` is set.

`FEATURE_SK` and `NEXT_PUBLIC_FEATURE_SK` are already on.

**On the page:**
1. Signed in as the parent, open `https://app.sketchcast.app/activate`.
2. **For which child?** With one child, they are preselected. With two, choose one; there is no default.
3. Paste the SKE code. The Amazon order number field appears.
4. Enter any 17-digit number in the form `123-1234567-1234567`. Each order number activates one copy, so use a new one for every test (e.g. `111-0000000-0000001`, `…0002`).
5. Expect "Biology: Cells - … is now unlocked for Aisyah." and the tutoring date.
6. Check for refusals. Re-using the same order number gives "This order number has already been used…". A wrong code gives "That code isn't recognised…". After 5 failures in an hour, you get "Too many attempts…".

**In SK (optional):**
- This needs `SK_ROLES` to include `parent`.
- A parent without a school also needs `SK_SHELL_CONSUMER=true`. Per the S4 design, confirm what that opens before you set it.

Steps:
1. Type `activate my book code SKE-… for Aisyah`.
2. SK asks for the order number. Type it.
3. A card appears: "Activate a book code for Aisyah", with the code masked (`SKE-••••-••••-••••-•XYZW`).
4. Click **Confirm**. A spoken "yes" is refused, because spending a code needs a click.

**Check the grant** (read-only, Supabase SQL editor):

```sql
select g.user_id, p.full_name, g.source, g.granted_by, g.activated_at, g.tutor_expires_at
from book_access_grants g join profiles p on p.id = g.user_id
order by g.activated_at desc limit 5;
```

`user_id` is the child, `granted_by` is the parent, and `source` is `edition_code`.

## 4. After testing

Retire the test code so it can't be shared:

```sql
update edition_codes set status = 'revoked' where edition = 'test-2026-10';
```

A revoked edition code reads as "That code isn't recognised" on the page and in SK.
