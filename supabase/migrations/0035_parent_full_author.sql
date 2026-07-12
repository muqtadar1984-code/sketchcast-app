-- 0035 — Parents become full authors.
--
-- Until now a parent-role account could only generate test papers (exam_paper):
-- enforce_parent_generation_kind() in 0018 raised on any other kind. Product
-- decision (2026-07-11): parents are full creators for their own children —
-- upload books + generate every artifact, including lesson plans. Authoring is
-- already ownership-based at the RLS layer (any adult may own books/generations),
-- so lifting this one trigger is all that's needed server-side. Per-generation
-- caps still apply via effective_cap keyed on the parent's OWN entitlement.
-- Idempotent.

drop trigger if exists parent_generation_kind on public.generations;
drop function if exists enforce_parent_generation_kind();
