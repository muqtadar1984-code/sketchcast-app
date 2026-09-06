/**
 * Parse-check for supabase/migrations/0115_catalogue_kits.sql (Phase 3, the
 * kit). What must hold:
 *  • one live topic_questions job per (topic, language) — a partial unique
 *    index on jobs.params shaped like 0114's jobs_one_live_article;
 *  • topic_kits.part_plan, additive with a default;
 *  • create_job_for_generation() keeps `security definer set search_path =
 *    public` (it inserts into jobs on behalf of the client's insert), copies
 *    exactly {catalogue, topic_id, kit_id, question_set_id} into jobs.params
 *    for a flagged row, and the unflagged branch is 0001's statement byte for
 *    byte — an ordinary teacher's row must get the job it always did;
 *  • approve_topic_kit / reject_topic_kit are service-role-only SECURITY
 *    DEFINER RPCs that lock the kit, refuse with check_violation /
 *    no_data_found, check the TOPIC's status (approve: in_review; reject:
 *    in_review | video_approved — a kit Regenerate left behind is history)
 *    and, for approve, that the kit's ARTICLE is still the approved version,
 *    move the topic and audit as library_kit_approve / library_kit_reject;
 *  • repoint_kit_generation is a service-role-only SECURITY DEFINER RPC that
 *    repoints one kind of a GENERATING kit in ONE statement — jsonb `||` for
 *    doc_generation_ids (a sibling key another writer merged in survives),
 *    the column for the presentation — after a compare-and-swap on the id
 *    being replaced (check_violation when the pointer moved);
 *  • THE GATE: 'approved' and 'rejected' are written to topic_kits ONLY inside
 *    the approve / reject function bodies — nowhere else in the migration, and
 *    no /api/library route writes them (the kit route calls the RPCs by name).
 * Run: npx vitest run src/utils/__tests__/migration-0115-catalogue-kits.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0115_catalogue_kits.sql");
const M0001 = read("0001_init.sql");

/** Comment-stripped DDL only. */
const code = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");
const c = code(M);

/** The `create or replace function [public.]<name>(…) … $$;` block. */
function fn(sql: string, name: string): string {
  const m = new RegExp("^create or replace function (?:public[.])?" + name + "[(][^)]*[)][\\s\\S]*?[$][$];", "m").exec(sql);
  expect(m, `${name} not found`).not.toBeNull();
  return m![0];
}

const API_LIBRARY = path.resolve(__dirname, "../../app/api/library");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("0115 — catalogue kits", () => {
  it("is one additive transaction: no table, no policy, no enum change", () => {
    expect(c.startsWith("begin;")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
    expect(c.toLowerCase()).not.toContain("create table");
    expect(c.toLowerCase()).not.toContain("create policy");
    expect(c.toLowerCase()).not.toContain("alter type");
    expect(c.toLowerCase()).not.toContain("drop table");
  });

  it("enforces one live topic_questions job per (topic, language) like 0114's article index", () => {
    expect(c).toContain("create unique index if not exists jobs_one_live_questions");
    expect(c).toContain("on public.jobs ((params->>'topic_id'), (coalesce(params->>'language', 'en')))");
    expect(c).toContain("where type = 'topic_questions' and status in ('queued', 'processing');");
  });

  it("adds topic_kits.part_plan with a default, and nothing else to the table", () => {
    expect(c).toContain("alter table public.topic_kits add column if not exists part_plan jsonb not null default '[]'::jsonb;");
    expect(c.match(/alter table public\.topic_kits/g)).toHaveLength(1);
  });

  it("create_job_for_generation keeps security definer + search_path and copies exactly the catalogue params", () => {
    const body = fn(c, "create_job_for_generation");
    expect(body).toContain("returns trigger\n  language plpgsql security definer set search_path = public as");
    // the flag is read the way 0112's guards read it
    expect(body).toContain("if coalesce(new.params->>'catalogue', '') = 'true' then");
    // the flagged branch writes jobs.params with exactly these four keys
    expect(body).toContain("insert into jobs (generation_id, type, status, params)");
    expect(body).toContain("'catalogue', true,");
    expect(body).toContain("'topic_id', new.params->'topic_id',");
    expect(body).toContain("'kit_id', new.params->'kit_id',");
    expect(body).toContain("'question_set_id', new.params->'question_set_id')");
    expect(body).toContain("jsonb_strip_nulls(");
    const keys = [...body.matchAll(/'([a-z_]+)', (?:true|new\.params->'[a-z_]+')/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(["catalogue", "kit_id", "question_set_id", "topic_id"]);
    // the unflagged branch is 0001's statement, byte for byte
    const original = "insert into jobs (generation_id, type, status) values (new.id, new.kind::text, 'queued');";
    expect(fn(code(M0001), "create_job_for_generation")).toContain(original);
    expect(body).toContain(original);
    // the trigger itself is not recreated: create or replace keeps it bound
    expect(c).not.toMatch(/create trigger on_generation_created/);
    expect(c).not.toMatch(/drop function/);
  });

  it("approve_topic_kit: lock, refuse when the kit is not in_review, the TOPIC not in_review or the ARTICLE not approved; approve with the reviewer, move the topic, audit — service role only", () => {
    const body = fn(c, "approve_topic_kit");
    expect(body).toContain("language plpgsql security definer set search_path = public as");
    expect(body).toContain("select * into k from topic_kits where id = p_kit for update;");
    expect(body).toContain("using errcode = 'no_data_found'");
    expect(body).toContain("if k.status <> 'in_review' then");
    expect(body).toContain("using errcode = 'check_violation'");
    // the topic is locked AND read: a kit whose topic is not in review (the
    // one Regenerate left behind) is not the kit under review
    expect(body).toContain("select status into t_status from topics where id = k.topic_id for update;");
    expect(body).toContain("if t_status is distinct from 'in_review' then");
    // the kit's article must still be THE approved version
    expect(body).toContain("select status into a_status from topic_articles where id = k.article_id;");
    expect(body).toContain("if a_status is distinct from 'approved' then");
    // both refusals come BEFORE the write and raise check_violation
    const write = body.indexOf("set status = 'approved'");
    expect(body.indexOf("if t_status is distinct from 'in_review' then")).toBeLessThan(write);
    expect(body.indexOf("if a_status is distinct from 'approved' then")).toBeLessThan(write);
    expect(body.match(/using errcode = 'check_violation'/g)!.length).toBeGreaterThanOrEqual(3);
    expect(body).toContain("set status = 'approved', approved_by = p_reviewer, reviewer_id = p_reviewer,");
    expect(body).toContain("update topics set status = 'video_approved'\n   where id = k.topic_id and status = 'in_review';");
    expect(body).toContain("insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)");
    expect(body).toContain("'library_kit_approve', 'topic', k.topic_id");
    expect(c).toContain("revoke execute on function public.approve_topic_kit(uuid, uuid, text) from public, anon, authenticated;");
    expect(c).toContain("grant execute on function public.approve_topic_kit(uuid, uuid, text) to service_role;");
  });

  it("reject_topic_kit: requires a listed reason and notes, accepts in_review | approved with the topic in_review | video_approved, reopens a pulled approval, audits", () => {
    const body = fn(c, "reject_topic_kit");
    expect(body).toContain("language plpgsql security definer set search_path = public as");
    expect(body).toContain("p_reason not in ('factual','grade_fit','pacing','visuals','pronunciation','translation','other')");
    expect(body).toContain("if p_notes is null or btrim(p_notes) = '' then");
    expect(body).toContain("if k.status not in ('in_review', 'approved') then");
    // the topic is locked AND read: a kit is rejected only while its topic is
    // in review (kit in_review) or video approved (kit approved)
    expect(body).toContain("select status into t_status from topics where id = k.topic_id for update;");
    expect(body).toContain("if t_status is distinct from 'in_review' and t_status is distinct from 'video_approved' then");
    expect(body.indexOf("if t_status is distinct from 'in_review' and")).toBeLessThan(body.indexOf("set status = 'rejected'"));
    expect(body).toContain("set status = 'rejected', reject_reason = p_reason, reviewer_id = p_reviewer,");
    expect(body).toContain("update topics set status = 'in_review'\n   where id = k.topic_id and status = 'video_approved';");
    expect(body).toContain("'library_kit_reject', 'topic', k.topic_id");
    expect(body).toContain("'reason', p_reason");
    expect(c).toContain("revoke execute on function public.reject_topic_kit(uuid, uuid, text, text) from public, anon, authenticated;");
    expect(c).toContain("grant execute on function public.reject_topic_kit(uuid, uuid, text, text) to service_role;");
  });

  it("repoint_kit_generation: lock a GENERATING kit, compare-and-swap the current pointer, merge with jsonb || — service role only; the kit route's retry calls it", () => {
    const body = fn(c, "repoint_kit_generation");
    expect(body).toContain("language plpgsql security definer set search_path = public as");
    expect(body).toContain("select * into k from topic_kits where id = p_kit for update;");
    expect(body).toContain("using errcode = 'no_data_found'");
    expect(body).toContain("if k.status <> 'generating' then");
    // the CAS: the kit must still point at p_replaces for that kind
    expect(body).toContain("if current_id is distinct from p_replaces then");
    expect(body.indexOf("if current_id is distinct from p_replaces then")).toBeLessThan(body.indexOf("update topic_kits"));
    // a merge, never a replace: a sibling key another writer added survives
    expect(body).toContain("set doc_generation_ids = coalesce(doc_generation_ids, '{}'::jsonb) || jsonb_build_object(p_kind, p_generation::text)");
    expect(body).not.toMatch(/set doc_generation_ids = jsonb_build_object/);
    expect(body).toContain("update topic_kits set presentation_generation_id = p_generation where id = k.id returning * into k;");
    // it never touches a kit's status
    expect(body).not.toMatch(/set status/);
    expect(c).toContain("revoke execute on function public.repoint_kit_generation(uuid, text, uuid, uuid) from public, anon, authenticated;");
    expect(c).toContain("grant execute on function public.repoint_kit_generation(uuid, text, uuid, uuid) to service_role;");
    // …and the kit route's retry repoints ONLY through it, with the id it replaces
    const kitRoute = walk(API_LIBRARY).find((f) => /topics[\\/]\[id\][\\/]kit[\\/]route\.ts$/.test(f));
    const route = readFileSync(kitRoute!, "utf8");
    expect(route).toMatch(/admin\.rpc\(\s*["']repoint_kit_generation["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_kind:\s*kind,\s*p_generation:\s*newId,\s*p_replaces:\s*old\.id\s*\}\s*\)/);
    const retry = route.slice(route.indexOf('if (action === "retry")'), route.indexOf('if (action === "save_clips")'));
    expect(retry).not.toMatch(/doc_generation_ids:/);
    expect(retry).not.toMatch(/presentation_generation_id:/);
  });

  it("the gate: 'approved' / 'rejected' are written only inside the two RPC bodies, and no route writes them", () => {
    const approve = fn(c, "approve_topic_kit");
    const reject = fn(c, "reject_topic_kit");
    const outside = c.replace(approve, "").replace(reject, "");
    expect(outside).not.toMatch(/status\s*=\s*'approved'/);
    expect(outside).not.toMatch(/status\s*=\s*'rejected'/);
    expect(approve.match(/set status = 'approved'/g)).toHaveLength(1);
    expect(reject.match(/set status = 'rejected'/g)).toHaveLength(1);

    // …and the app side: every topic_kits write chain under /api/library is
    // free of both statuses, and the kit route reaches them by the RPC names
    // declared here (so a rename on either side fails this test).
    const files = walk(API_LIBRARY);
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      for (const m of t.matchAll(/\.from\(\s*["']topic_kits["']\s*\)/g)) {
        const chain = t.slice(m.index!, t.indexOf(";", m.index!));
        if (/\.(update|insert|upsert)\(/.test(chain)) {
          expect(chain, `${path.relative(API_LIBRARY, f)}: a topic_kits write may not set approved / rejected`).not.toMatch(
            /["']?status["']?\s*:\s*["'](approved|rejected)["']/,
          );
        }
      }
    }
    const kitRoute = files.find((f) => /topics[\\/]\[id\][\\/]kit[\\/]route\.ts$/.test(f));
    expect(kitRoute, "the kit route exists").toBeDefined();
    const route = readFileSync(kitRoute!, "utf8");
    expect(route).toMatch(/admin\.rpc\(\s*["']approve_topic_kit["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_reviewer:\s*m\.id,\s*p_notes:\s*notes\s*\}\s*\)/);
    expect(route).toMatch(/admin\.rpc\(\s*["']reject_topic_kit["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_reviewer:\s*m\.id,\s*p_reason:\s*reason,\s*p_notes:\s*notes\s*\}\s*\)/);
  });
});
