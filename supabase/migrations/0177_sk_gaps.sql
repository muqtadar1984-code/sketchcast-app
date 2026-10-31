-- 0177: SK gap tracker (founder 2026-10-31, "SK - Gap tracker design 2026-10-31").
--
-- sk_gaps        one row per (turn, signal) where SK could not help: it said so
--                itself (sk.note_gap), a built-in refusal fired, a tool failed,
--                the fact-check dropped claims, the reply matched the "I can't"
--                phrase net, or the user pressed 👎. Students included; the
--                question is stored AS ASKED — book codes are NOT masked here
--                (founder decision: the exact input is needed to replay it).
--                question / reply / context are cleared after 90 days
--                (text_purged_at); the row and its theme link stay for counts.
-- sk_gap_themes  the nightly grouping's output: one theme per kind of miss,
--                with the founder's verdict and, when accepted, the
--                platform_issues ticket it became.
--
-- Service role only: written by the SK turn route, read and changed by the
-- console. No client role gets a row.
begin;

create table if not exists public.sk_gap_themes (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  title         text not null check (char_length(title) <= 200),
  summary       text check (char_length(summary) <= 2000),
  status        text not null default 'open'
                check (status in ('open','accepted','wont_do','already_possible','fixed')),
  issue_id      uuid references public.platform_issues(id) on delete set null,
  fixed_pr      text check (char_length(fixed_pr) <= 200),
  note          text check (char_length(note) <= 2000),
  last_seen_at  timestamptz,
  retest        jsonb
);
create index if not exists sk_gap_themes_status_idx on public.sk_gap_themes (status, last_seen_at desc);

create table if not exists public.sk_gaps (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  turn_id         text not null check (char_length(turn_id) <= 100),
  user_id         uuid references public.profiles(id) on delete set null,
  role            text check (char_length(role) <= 40),
  locale          text check (char_length(locale) <= 20),
  page            text check (char_length(page) <= 500),
  modality        text check (char_length(modality) <= 20),
  signal          text not null
                  check (signal in ('self','refusal','tool_failed','grounding','phrase','thumbs_down')),
  question        text check (char_length(question) <= 4000),
  reply           text check (char_length(reply) <= 1000),
  wanted          text check (char_length(wanted) <= 500),
  route           text check (char_length(route) <= 60),
  tools           text[] not null default '{}',
  context         jsonb,
  theme_id        uuid references public.sk_gap_themes(id) on delete set null,
  status          text not null default 'new'
                  check (status in ('new','grouped','dismissed')),
  text_purged_at  timestamptz,
  unique (turn_id, signal)
);
create index if not exists sk_gaps_status_idx  on public.sk_gaps (status, created_at);
create index if not exists sk_gaps_theme_idx   on public.sk_gaps (theme_id, created_at desc);
create index if not exists sk_gaps_created_idx on public.sk_gaps (created_at);

alter table public.sk_gaps enable row level security;
alter table public.sk_gap_themes enable row level security;
revoke all on public.sk_gaps from anon, authenticated;
revoke all on public.sk_gap_themes from anon, authenticated;

commit;
