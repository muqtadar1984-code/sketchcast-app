-- ── 0044: close the PUBLIC-execute hole on tutor SECURITY DEFINER RPCs ───────
-- Postgres grants EXECUTE on every new function to PUBLIC implicitly, and
-- anon/authenticated inherit that grant. Migrations 0025–0028 revoked only
-- anon/authenticated, so these functions stayed callable through PostgREST
-- (/rest/v1/rpc) by anyone holding the public anon key:
--   * tutor_mastery_summary(p_student, ...) returns mastery aggregates for an
--     ARBITRARY student uuid — cross-tenant data exposure.
--   * tutor_tts_reserve / tutor_sketch_reserve can be spammed to burn quota.
-- Every app caller goes through the service-role client
-- (src/utils/supabase/admin.ts); no client-side session calls these, so the
-- only roles that need EXECUTE are postgres (owner) and service_role.

revoke execute on function public.tutor_qa_match(uuid, int, text, real)          from public, anon, authenticated;
revoke execute on function public.tutor_qa_bump(uuid, int)                       from public, anon, authenticated;
revoke execute on function public.tutor_mastery_summary(uuid, uuid, int)         from public, anon, authenticated;
revoke execute on function public.tutor_tts_reserve(uuid, text, text, int, int)  from public, anon, authenticated;
revoke execute on function public.tutor_sketch_reserve(uuid, text, int)          from public, anon, authenticated;

-- Revoking PUBLIC removes the implicit grant service_role may have been riding
-- on — keep its access explicit. (postgres retains access as function owner.)
grant execute on function public.tutor_qa_match(uuid, int, text, real)           to service_role;
grant execute on function public.tutor_qa_bump(uuid, int)                        to service_role;
grant execute on function public.tutor_mastery_summary(uuid, uuid, int)          to service_role;
grant execute on function public.tutor_tts_reserve(uuid, text, text, int, int)   to service_role;
grant execute on function public.tutor_sketch_reserve(uuid, text, int)           to service_role;
