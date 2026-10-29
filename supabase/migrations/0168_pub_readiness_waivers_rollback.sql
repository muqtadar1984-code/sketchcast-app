-- Rollback for 0168_pub_readiness_waivers.sql. Drops the waivers; the next readiness re-check counts the checks again.
drop trigger if exists pub_readiness_waivers_guard on public.pub_readiness_waivers;
drop table if exists public.pub_readiness_waivers;
drop function if exists public.pub_readiness_waivers_guard();
