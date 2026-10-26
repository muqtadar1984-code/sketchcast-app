-- 0158: SK book access — printed activation codes, per-book access GRANTS,
-- usage allowance, guardian consent. (SK plan §11 / R3 refinement 4.)
--
-- A redeemed code is NOT a subscription: it is a `book_access_grant` with a
-- publisher and print-batch attribution, an activation date, an expiry and a
-- usage allowance. Subscriptions (`entitlements`) and school licences stay
-- where they are; one check — sk_access() in the app — reads all three.
--
-- Only the HMAC of a code is stored (BOOK_CODE_SECRET in the app); a leaked
-- table cannot be turned back into printable codes. Redemption is one
-- SECURITY DEFINER function so a code is single-use under concurrency; it
-- RETURNS its outcome rather than raising, because a raised exception would
-- discard the attempt row written in the same call and the rate limit could
-- never trip (found by supabase/tests/0158_sk_book_access_test.sql on the
-- sk-b1 branch database).
--
-- product_id references the SK book product (sk_book_products, migration
-- 0156, on a parallel branch); the FK is added once both are on main.
-- Additive; nothing here changes an existing table. Rollback: 0158_..._rollback.sql.
begin;

create table if not exists public.publishers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  market      text,                                   -- 'MY', 'IN', …
  created_at  timestamptz not null default now()
);

create table if not exists public.print_batches (
  id           uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references public.publishers(id) on delete restrict,
  product_id   uuid not null,
  market       text,
  quantity     integer not null check (quantity > 0),
  code_prefix  text not null,                         -- first block printed on every code, e.g. 'SKB2'
  printed_at   date,
  revoked_at   timestamptz,                           -- revoking a batch refuses every unredeemed code in it
  created_at   timestamptz not null default now()
);

create table if not exists public.book_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hmac   text not null unique,                   -- HMAC-SHA256(normalised code, BOOK_CODE_SECRET), hex
  product_id  uuid not null,
  batch_id    uuid not null references public.print_batches(id) on delete restrict,
  status      text not null default 'unused' check (status in ('unused', 'redeemed', 'revoked')),
  redeemed_by uuid references public.profiles(id) on delete set null,
  redeemed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists book_codes_batch_idx on public.book_codes (batch_id);

create table if not exists public.book_access_grants (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  product_id      uuid not null,
  source          text not null check (source in ('code', 'promo', 'staff', 'renewal')),
  code_id         uuid references public.book_codes(id) on delete set null,
  publisher_id    uuid references public.publishers(id) on delete set null,
  batch_id        uuid references public.print_batches(id) on delete set null,
  activated_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  renewal_of      uuid references public.book_access_grants(id) on delete set null,
  -- Fair-use allowance for LIVE interaction within the grant (plan §11): the
  -- numbers are set after the cost measurements; prepared teaching is never
  -- metered. Null = no live allowance recorded yet (treated as unlimited by
  -- the app ONLY while FEATURE_SK_ALLOWANCE is off).
  usage_allowance jsonb,                              -- {"live_turns": 300, "generated_segments": 40}
  granted_by      uuid references public.profiles(id) on delete set null,  -- staff/parent who redeemed for a child
  created_at      timestamptz not null default now()
);
create index if not exists book_access_grants_user_idx on public.book_access_grants (user_id, product_id);
create index if not exists book_access_grants_batch_idx on public.book_access_grants (batch_id);

-- Live-interaction usage per user × product × calendar month.
create table if not exists public.sk_usage (
  user_id            uuid not null references public.profiles(id) on delete cascade,
  product_id         uuid not null,
  period             text not null,                   -- 'YYYY-MM'
  live_turns         integer not null default 0,
  generated_segments integer not null default 0,
  interactive_ms     bigint  not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (user_id, product_id, period)
);

-- Failed redemption attempts, for the per-account rate limit (5 per hour).
create table if not exists public.book_code_attempts (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         inet,
  at         timestamptz not null default now(),
  outcome    text not null check (outcome in ('redeemed', 'invalid', 'used', 'revoked', 'rate_limited', 'not_your_child'))
);
create index if not exists book_code_attempts_user_idx on public.book_code_attempts (user_id, at desc);

-- Guardian consent per child and scope (voice, transcripts, analytics).
create table if not exists public.consents (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid not null references public.profiles(id) on delete cascade,
  guardian_id uuid not null references public.profiles(id) on delete cascade,
  scope       text not null check (scope in ('voice', 'transcripts', 'analytics')),
  granted_at  timestamptz not null default now(),
  method      text not null default 'in_app',
  revoked_at  timestamptz,
  unique (child_id, scope, guardian_id)
);

-- ── Redemption: single-use under concurrency ─────────────────────────────────
-- Returns jsonb: {"outcome": "redeemed", "grant": {...row...}} or
-- {"outcome": "invalid" | "used" | "revoked" | "rate_limited" | "not_your_child"}.
-- The route maps the outcome to a friendly message; the raw outcome is never
-- shown. The code row is locked FOR UPDATE so two redemptions of the same code
-- cannot both succeed. Every call writes ONE book_code_attempts row, which is
-- why failures are returned and not raised (a raise would roll that row back).
drop function if exists public.redeem_book_code(text, uuid, uuid, integer);
create function public.redeem_book_code(p_code_hmac text, p_user uuid, p_for_child uuid default null, p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   public.book_codes%rowtype;
  v_batch  public.print_batches%rowtype;
  v_target uuid := coalesce(p_for_child, p_user);
  v_grant  public.book_access_grants%rowtype;
  v_fails  integer;
begin
  select count(*) into v_fails from public.book_code_attempts
   where user_id = p_user and at > now() - interval '1 hour' and outcome <> 'redeemed';
  if v_fails >= 5 then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'rate_limited');
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select * into v_code from public.book_codes where code_hmac = p_code_hmac for update;
  if not found then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'invalid');
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_batch from public.print_batches where id = v_code.batch_id;
  if v_code.status = 'revoked' or v_batch.revoked_at is not null then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'revoked');
    return jsonb_build_object('outcome', 'revoked');
  end if;
  if v_code.status <> 'unused' then
    insert into public.book_code_attempts (user_id, outcome) values (p_user, 'used');
    return jsonb_build_object('outcome', 'used');
  end if;
  -- A parent may redeem for a linked, verified child only.
  if p_for_child is not null and p_for_child <> p_user then
    if not exists (select 1 from public.parent_links where parent_id = p_user and child_id = p_for_child and verified_at is not null) then
      insert into public.book_code_attempts (user_id, outcome) values (p_user, 'not_your_child');
      return jsonb_build_object('outcome', 'not_your_child');
    end if;
  end if;

  update public.book_codes set status = 'redeemed', redeemed_by = v_target, redeemed_at = now() where id = v_code.id;
  insert into public.book_access_grants (user_id, product_id, source, code_id, publisher_id, batch_id, expires_at, granted_by)
  values (v_target, v_code.product_id, 'code', v_code.id, v_batch.publisher_id, v_batch.id, now() + make_interval(days => p_days),
          case when v_target <> p_user then p_user else null end)
  returning * into v_grant;
  insert into public.book_code_attempts (user_id, outcome) values (p_user, 'redeemed');
  return jsonb_build_object('outcome', 'redeemed', 'grant', to_jsonb(v_grant));
end;
$$;
revoke all on function public.redeem_book_code(text, uuid, uuid, integer) from public, anon, authenticated;

-- ── Retention (plan §14) ─────────────────────────────────────────────────────
-- One sweep the service role (or a pg_cron job, scheduled separately with the
-- founder's approval) calls daily. Today it only trims the redemption-attempt
-- log, which the rate limit needs for an hour; B4/B5 add their transcript
-- tables here (30-day retention) rather than scheduling sweeps of their own.
create or replace function public.sk_retention_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts bigint;
begin
  delete from public.book_code_attempts where at < now() - interval '7 days';
  get diagnostics v_attempts = row_count;
  return jsonb_build_object('book_code_attempts', v_attempts);
end;
$$;
revoke all on function public.sk_retention_sweep() from public, anon, authenticated;

-- ── RLS: service role writes; people read their own ──────────────────────────
alter table public.publishers         enable row level security;
alter table public.print_batches      enable row level security;
alter table public.book_codes         enable row level security;
alter table public.book_access_grants enable row level security;
alter table public.sk_usage           enable row level security;
alter table public.book_code_attempts enable row level security;
alter table public.consents           enable row level security;

drop policy if exists sk_grants_read_own on public.book_access_grants;
create policy sk_grants_read_own on public.book_access_grants
  for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.parent_links pl where pl.parent_id = auth.uid() and pl.child_id = user_id and pl.verified_at is not null));

drop policy if exists sk_usage_read_own on public.sk_usage;
create policy sk_usage_read_own on public.sk_usage
  for select to authenticated using (user_id = auth.uid());

drop policy if exists consents_read_own on public.consents;
create policy consents_read_own on public.consents
  for select to authenticated using (child_id = auth.uid() or guardian_id = auth.uid());

-- No policies on publishers / print_batches / book_codes / book_code_attempts:
-- staff and the service role only (RLS on, nothing granted to authenticated).

commit;
