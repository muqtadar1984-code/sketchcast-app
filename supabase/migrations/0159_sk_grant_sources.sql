-- 0159: SK grant sources — digital PURCHASE grants (Lemon Squeezy) and
-- EDITION-CODE grants (KDP copies), permanent book access with a separate
-- tutoring window. (Book Distribution and Access Plan 2026-10-27 §3–§6, §9.)
--
-- What changes, and why:
--   * book_access_grants.source gains 'purchase' and 'edition_code'. Every
--     buyer — portal, KDP, code card, promo, staff — ends as ONE grant row.
--   * BOOK ACCESS IS PERMANENT, SK TUTORING IS A WINDOW. 0158 forced
--     expires_at, which made book access itself expire with the tutoring.
--     expires_at is now nullable (NULL = permanent book access) and a new
--     tutor_expires_at carries the 30-day tutoring window. Existing rows are
--     back-filled: tutor_expires_at = the old expires_at, then expires_at =
--     NULL, so nobody who already activated loses their book.
--   * edition_codes: ONE code per printed edition (prefix SKE-), the same in
--     every KDP copy because KDP prints one file for all copies and reports no
--     buyer identity. A copy activates with that code PLUS the buyer's Amazon
--     order number; each order number is usable once (order_claims) and each
--     edition code accepts at most daily_cap claims per rolling 24 h, so a
--     leaked edition code is rate-limited rather than open.
--   * book_purchases: a Lemon Squeezy one-off product per book
--     (sk_book_products.ls_product_id). Parked by the buyer's email like a
--     credit pack and claimed on sign-in (claim.ts); a claimed purchase is a
--     'purchase' grant. A refund revokes the grant.
--   * redeem_edition_code(): the edition twin of redeem_book_code() — RETURNS
--     its outcome rather than raising so the attempt row survives and the
--     shared 5-failures-per-hour rate limit (book_code_attempts) can trip.
--
-- Plain codes and plain order numbers are NEVER stored: only HMACs
-- (BOOK_CODE_SECRET in the app). Additive; rollback: 0159_..._rollback.sql.
-- Applied + tested on the sk-b1 branch database only — production needs the
-- founder's explicit yes.
begin;

-- ── 1. book_access_grants: new sources, permanent book access, tutor window ──
alter table public.book_access_grants drop constraint if exists book_access_grants_source_check;
alter table public.book_access_grants add constraint book_access_grants_source_check
  check (source in ('code', 'promo', 'staff', 'renewal', 'purchase', 'edition_code'));

alter table public.book_access_grants add column if not exists tutor_expires_at timestamptz;
alter table public.book_access_grants add column if not exists edition_code_id uuid;

-- Back-fill BEFORE relaxing the NOT NULL: every pre-0159 grant keeps its old
-- expiry as the tutoring window and becomes permanent book access.
update public.book_access_grants
   set tutor_expires_at = expires_at
 where tutor_expires_at is null;
alter table public.book_access_grants alter column expires_at drop not null;
update public.book_access_grants set expires_at = null where expires_at is not null;

comment on column public.book_access_grants.expires_at is
  'When BOOK access ends. NULL = permanent (every purchase, code and edition grant since 0159).';
comment on column public.book_access_grants.tutor_expires_at is
  'When live SK TUTORING on this grant ends (30 days per activation, plan §4). NULL = no tutoring window.';

-- ── 2. Edition codes (KDP) + order claims ────────────────────────────────────
create table if not exists public.edition_codes (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.sk_book_products(id) on delete restrict,
  edition         text not null,                          -- the edition string printed in the book, e.g. 'kdp-2026-1'
  channel         text not null default 'kdp',
  code_hmac       text not null unique,                   -- HMAC-SHA256(normalised SKE- code, BOOK_CODE_SECRET), hex
  daily_cap       integer not null default 50 check (daily_cap > 0),  -- claims per rolling 24 h
  usage_allowance jsonb,                                  -- copied onto each grant; smaller than a code card's (plan §6)
  status          text not null default 'active' check (status in ('active', 'revoked')),
  created_at      timestamptz not null default now(),
  unique (product_id, edition)
);

create table if not exists public.order_claims (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null default 'kdp',
  order_hmac      text not null unique,                   -- HMAC-SHA256(normalised order number, BOOK_CODE_SECRET), hex
  edition_code_id uuid not null references public.edition_codes(id) on delete restrict,
  grant_id        uuid references public.book_access_grants(id) on delete set null,
  user_id         uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists order_claims_edition_recent_idx on public.order_claims (edition_code_id, created_at desc);

alter table public.book_access_grants drop constraint if exists book_access_grants_edition_code_id_fkey;
alter table public.book_access_grants add constraint book_access_grants_edition_code_id_fkey
  foreign key (edition_code_id) references public.edition_codes(id) on delete set null;

-- ── 3. Digital purchases (Lemon Squeezy one-off product per book) ────────────
alter table public.sk_book_products add column if not exists ls_product_id text unique;
comment on column public.sk_book_products.ls_product_id is
  'Lemon Squeezy product id of the book''s one-off listing; the webhook maps an order to this product by it.';

create table if not exists public.book_purchases (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null default 'lemonsqueezy' check (provider in ('lemonsqueezy')),
  ls_order_id    text not null unique,                    -- idempotency: LS re-delivery is a no-op
  product_id     uuid not null references public.sk_book_products(id) on delete restrict,
  owner_id       uuid references public.profiles(id) on delete set null,   -- NULL while parked
  claim_email    text,                                    -- lower-cased LS email, set only while parked
  grant_id       uuid references public.book_access_grants(id) on delete set null,
  total_minor    integer,                                 -- what LS charged, net of tax (handlers.ts lsNetOfTax)
  total_currency text,
  order_status   text,
  refunded_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists book_purchases_claim_idx on public.book_purchases (claim_email) where owner_id is null;
create index if not exists book_purchases_owner_idx on public.book_purchases (owner_id);

-- ── 4. Attempt outcomes ──────────────────────────────────────────────────────
alter table public.book_code_attempts drop constraint if exists book_code_attempts_outcome_check;
alter table public.book_code_attempts add constraint book_code_attempts_outcome_check
  check (outcome in ('redeemed', 'invalid', 'used', 'revoked', 'rate_limited', 'not_your_child', 'order_used', 'daily_cap'));

-- ── 5. redeem_edition_code(): edition code + order number → one grant ────────
-- Returns jsonb: {"outcome": "redeemed", "grant": {...row...}} or
-- {"outcome": "invalid" | "order_used" | "daily_cap" | "not_your_child" | "rate_limited"}.
-- A revoked edition reads as 'invalid' (nothing to tell a stranger apart). The
-- edition row is locked FOR UPDATE so concurrent claims of one edition are
-- serialised and the daily cap cannot be overshot; a duplicate order number
-- on a DIFFERENT edition is caught by the unique index and reported as
-- order_used without consuming anything (the grant insert sits in the same
-- sub-block and is rolled back with it). Every call writes ONE attempt row.
drop function if exists public.redeem_edition_code(text, text, uuid, uuid, integer, text);
create function public.redeem_edition_code(
  p_code_hmac text, p_order_hmac text, p_user uuid, p_for_child uuid default null, p_days integer default 30, p_channel text default 'kdp')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ed     public.edition_codes%rowtype;
  v_target uuid := coalesce(p_for_child, p_user);
  v_grant  public.book_access_grants%rowtype;
  v_fails  integer;
  v_claims integer;
begin
  select count(*) into v_fails from public.book_code_attempts
   where user_id = p_user and at > now() - interval '1 hour' and outcome <> 'redeemed';
  if v_fails >= 5 then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'rate_limited');
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select * into v_ed from public.edition_codes where code_hmac = p_code_hmac for update;
  if not found or v_ed.status <> 'active' then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'invalid');
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if exists (select 1 from public.order_claims where order_hmac = p_order_hmac) then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'order_used');
    return jsonb_build_object('outcome', 'order_used');
  end if;
  -- A parent may activate for a linked, verified child only (checked before
  -- the cap so a refused claim never consumes a slot).
  if p_for_child is not null and p_for_child <> p_user then
    if not exists (select 1 from public.parent_links where parent_id = p_user and child_id = p_for_child and verified_at is not null) then
      insert into public.book_code_attempts (user_id, outcome) values (p_user, 'not_your_child');
      return jsonb_build_object('outcome', 'not_your_child');
    end if;
  end if;
  select count(*) into v_claims from public.order_claims
   where edition_code_id = v_ed.id and created_at > now() - interval '24 hours';
  if v_claims >= v_ed.daily_cap then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'daily_cap');
    return jsonb_build_object('outcome', 'daily_cap');
  end if;

  begin
    insert into public.book_access_grants
      (user_id, product_id, source, edition_code_id, expires_at, tutor_expires_at, usage_allowance, granted_by)
    values
      (v_target, v_ed.product_id, 'edition_code', v_ed.id, null, now() + make_interval(days => p_days), v_ed.usage_allowance,
       case when v_target <> p_user then p_user else null end)
    returning * into v_grant;
    insert into public.order_claims (channel, order_hmac, edition_code_id, grant_id, user_id)
    values (p_channel, p_order_hmac, v_ed.id, v_grant.id, v_target);
  exception when unique_violation then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'order_used');
    return jsonb_build_object('outcome', 'order_used');
  end;
  insert into public.book_code_attempts (user_id, outcome) values (p_user, 'redeemed');
  return jsonb_build_object('outcome', 'redeemed', 'grant', to_jsonb(v_grant));
end;
$$;
revoke all on function public.redeem_edition_code(text, text, uuid, uuid, integer, text) from public, anon, authenticated;

-- ── 6. Purchases: record / claim / refund ────────────────────────────────────
-- record_book_purchase(): called by the Lemon Squeezy webhook for an order
-- whose product is a book. Idempotent on ls_order_id. With a known buyer the
-- grant is created at once; without one the purchase is PARKED by email and
-- claim_book_purchases() grants it when the account holder signs in with that
-- verified email. A refunded order records a tombstone and grants nothing.
-- Outcomes: granted | parked | duplicate | refunded.
drop function if exists public.record_book_purchase(text, uuid, uuid, text, integer, text, text, boolean, integer, jsonb);
create function public.record_book_purchase(
  p_order_id text, p_product uuid, p_user uuid, p_email text,
  p_total_minor integer default null, p_currency text default null, p_status text default null,
  p_refunded boolean default false, p_tutor_days integer default 30, p_allowance jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_grant public.book_access_grants%rowtype;
begin
  insert into public.book_purchases (ls_order_id, product_id, owner_id, claim_email, total_minor, total_currency, order_status, refunded_at)
  values (p_order_id, p_product, p_user, case when p_user is null then lower(nullif(trim(p_email), '')) end,
          p_total_minor, p_currency, p_status, case when p_refunded then now() end)
  on conflict (ls_order_id) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  if p_refunded then
    return jsonb_build_object('outcome', 'refunded');
  end if;
  if p_user is null then
    return jsonb_build_object('outcome', 'parked');
  end if;
  insert into public.book_access_grants (user_id, product_id, source, expires_at, tutor_expires_at, usage_allowance)
  values (p_user, p_product, 'purchase', null, now() + make_interval(days => p_tutor_days), p_allowance)
  returning * into v_grant;
  update public.book_purchases set grant_id = v_grant.id where id = v_id;
  return jsonb_build_object('outcome', 'granted', 'grant', to_jsonb(v_grant));
end;
$$;
revoke all on function public.record_book_purchase(text, uuid, uuid, text, integer, text, text, boolean, integer, jsonb) from public, anon, authenticated;

-- claim_book_purchases(): bind every purchase parked under the VERIFIED email
-- to the user and grant each one. Rows are locked so two tabs signing in at
-- once cannot both grant the same purchase. Returns {"bound": n}.
drop function if exists public.claim_book_purchases(uuid, text, integer, jsonb);
create function public.claim_book_purchases(p_user uuid, p_email text, p_tutor_days integer default 30, p_allowance jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.book_purchases%rowtype;
  v_grant public.book_access_grants%rowtype;
  v_n     integer := 0;
  v_email text := lower(nullif(trim(p_email), ''));
begin
  if p_user is null or v_email is null then
    return jsonb_build_object('bound', 0);
  end if;
  for v_row in
    select * from public.book_purchases
     where owner_id is null and claim_email = v_email and refunded_at is null
     for update skip locked
  loop
    insert into public.book_access_grants (user_id, product_id, source, expires_at, tutor_expires_at, usage_allowance)
    values (p_user, v_row.product_id, 'purchase', null, now() + make_interval(days => p_tutor_days), p_allowance)
    returning * into v_grant;
    update public.book_purchases set owner_id = p_user, claim_email = null, grant_id = v_grant.id where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('bound', v_n);
end;
$$;
revoke all on function public.claim_book_purchases(uuid, text, integer, jsonb) from public, anon, authenticated;

-- refund_book_purchase(): the order was refunded — stamp the purchase, revoke
-- its grant (book AND tutoring), and leave a refunded tombstone when the
-- refund arrives before its order_created so the retried create no-ops.
-- Returns {"outcome": "refunded" | "tombstone", "grant_revoked": bool}.
drop function if exists public.refund_book_purchase(text, uuid, text);
create function public.refund_book_purchase(p_order_id text, p_product uuid default null, p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.book_purchases%rowtype;
  v_revoked boolean := false;
begin
  select * into v_row from public.book_purchases where ls_order_id = p_order_id for update;
  if not found then
    if p_product is null then
      return jsonb_build_object('outcome', 'unknown', 'grant_revoked', false);
    end if;
    insert into public.book_purchases (ls_order_id, product_id, owner_id, claim_email, refunded_at)
    values (p_order_id, p_product, null, lower(nullif(trim(p_email), '')), now())
    on conflict (ls_order_id) do nothing;
    return jsonb_build_object('outcome', 'tombstone', 'grant_revoked', false);
  end if;
  update public.book_purchases set refunded_at = coalesce(refunded_at, now()) where id = v_row.id;
  if v_row.grant_id is not null then
    update public.book_access_grants set revoked_at = coalesce(revoked_at, now()) where id = v_row.grant_id;
    v_revoked := found;
  end if;
  return jsonb_build_object('outcome', 'refunded', 'grant_revoked', v_revoked);
end;
$$;
revoke all on function public.refund_book_purchase(text, uuid, text) from public, anon, authenticated;

-- ── 7. Privileges + RLS ─────────────────────────────────────────────────────
-- Supabase's default privileges hand anon/authenticated ALL on every new
-- public table (verified on production 2026-10-27: book_access_grants,
-- book_codes, publishers… all DELETE/INSERT/SELECT/UPDATE for anon), so RLS
-- (on, no policies) was the only thing keeping 0158's staff tables closed —
-- and on a branch database the default grants are absent, so the read-own
-- policies could not even be reached. Make it explicit, as 0156 did: nothing
-- for anon; authenticated may SELECT only where a read-own policy exists
-- (grants, usage, consents) and nothing on the staff tables. The policies
-- themselves are UNCHANGED: sk_grants_read_own (0158) still decides WHICH
-- rows a student sees — their own grants, a verified parent their child's.
alter table public.edition_codes  enable row level security;
alter table public.order_claims   enable row level security;
alter table public.book_purchases enable row level security;
revoke all on public.edition_codes, public.order_claims, public.book_purchases from anon, authenticated;
revoke all on public.publishers, public.print_batches, public.book_codes, public.book_code_attempts from anon, authenticated;
revoke all on public.book_access_grants, public.sk_usage, public.consents from anon, authenticated;
grant select on public.book_access_grants, public.sk_usage, public.consents to authenticated;

commit;
