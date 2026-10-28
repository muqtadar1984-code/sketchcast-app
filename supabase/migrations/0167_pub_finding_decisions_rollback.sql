-- Rollback for 0167_pub_finding_decisions.sql. Drops the rulings log; findings keep their current status.
drop trigger if exists pub_finding_decisions_immutable on public.pub_finding_decisions;
drop table if exists public.pub_finding_decisions;
