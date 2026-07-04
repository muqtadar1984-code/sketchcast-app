-- 0017 — the 'parent' role value.
-- ⚠️ MUST RUN ALONE as its own SQL-editor execution: ALTER TYPE ... ADD VALUE
-- has to commit before anything references the new value (0018/0019 do).
alter type user_role add value if not exists 'parent';
