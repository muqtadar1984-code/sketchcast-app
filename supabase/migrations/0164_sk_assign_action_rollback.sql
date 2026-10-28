-- 0164 rollback: remove the `assign` action RPC. Shares already written and
-- their sk_actions audit rows stay (they are ordinary Library data); only the
-- server-side path that SK uses to write them goes away.
begin;
drop function if exists public.sk_assign_with_token(uuid, text);
commit;
