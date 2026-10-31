-- 0179 rollback: remove concept tags, recommended plans and SK's focus
-- concepts. Drops the plans (approval records — export them first if any
-- exist) and the focus rows; the shares an approved plan created stay
-- (they are ordinary generation_shares rows, like any assignment). Nothing
-- else references these tables. 0178 is untouched.
begin;
drop function if exists public.sk_learn_plan_decide(uuid, text, jsonb, boolean, text);
drop table if exists public.sk_learn_focus;
drop table if exists public.sk_learn_plans;
drop table if exists public.sk_practice_concepts;
commit;
