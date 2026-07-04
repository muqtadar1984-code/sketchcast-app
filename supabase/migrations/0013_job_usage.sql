-- 0013 — per-job Claude usage (unit economics).
-- The worker writes {calls, input_tokens, output_tokens, cost_usd} per job so
-- API spend is attributable to a user/book/generation instead of vanishing
-- with the Railway container. Additive + inert: old workers simply don't
-- write it; readers treat NULL as "not tracked yet".
-- Run in the Supabase SQL editor as one execution (no enum changes).

alter table public.jobs add column if not exists usage jsonb;

comment on column public.jobs.usage is
  'Claude token/cost total for this job: {calls, input_tokens, output_tokens, cost_usd}';

-- Founder query — spend per user since a date:
--   select p.full_name, u.email, count(*) jobs,
--          round(sum((j.usage->>'cost_usd')::numeric), 2) usd
--   from jobs j
--   join generations g on g.id = j.generation_id
--   join profiles p on p.id = g.owner_id
--   join auth.users u on u.id = p.id
--   where j.usage is not null and j.created_at > now() - interval '30 days'
--   group by 1, 2 order by usd desc;
