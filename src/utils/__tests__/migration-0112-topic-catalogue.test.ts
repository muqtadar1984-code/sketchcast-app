/**
 * Parse-checks for supabase/migrations/0111_script_json_kind.sql and
 * 0112_topic_catalogue.sql — applied by the agent on the founder's explicit
 * 2026-09-06 instruction, so these are the automated eyes on the files.
 *
 * 0111 is ONE statement: the 'script_json' artifact kind (ALTER TYPE … ADD
 * VALUE must run alone — 0009/0062/0103 carry the same warning).
 *
 * 0112 (topic-catalogue plan §5, founder 2026-09-06). What must hold:
 *  • every catalogue table exists, has RLS on and is revoked from anon and
 *    authenticated — the portal is service-role only, like credit_grants;
 *  • the check constraints carry EXACTLY the plan's value lists (the app's
 *    status machine and the worker's item validator are written against them);
 *  • topic_candidates.raw_title is capped at 120 characters — the names-only
 *    guarantee (a sentence of book text can never be stored);
 *  • one approved article per (topic, language): a partial unique index;
 *  • the bank-maturity ladder thresholds 10/20/30/50/100 appear once each and
 *    the trigger fires on delete too;
 *  • THE TRIGGER EXEMPTIONS: reject_double_submit, enforce_fair_use and
 *    credit_ledger_write are re-declared with the catalogue guard as the FIRST
 *    statement (before any advisory lock), and each body minus the guard is
 *    byte-identical to its last defining migration (0103 / 0103 / 0089) —
 *    which is the live prod body (verified with pg_get_functiondef 2026-09-06);
 *  • THE FREE-RIDE GUARANTEE: fair_use_used, fair_use_used_since,
 *    credit_ledger_sync, plan_tier, fair_use_caps and premium_voices_allowed are
 *    NOT redefined here;
 *  • the only INSERT is the idempotent worksheet-preset seed; no enum change.
 * Run: npx vitest run src/utils/__tests__/migration-0112-topic-catalogue.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M0111 = read("0111_script_json_kind.sql");
const M0112 = read("0112_topic_catalogue.sql");
const M0103 = read("0103_deck_kind.sql");
const M0089 = read("0089_fix_part_map_seed.sql");

/** Comment-stripped DDL only. */
const code = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");

/** The `create or replace function [public.]<name>() … $$;` block. */
function fn(sql: string, name: string): string {
  // 0089 closes with `end $$;` on one line, 0103 with `$$;` on its own: accept both.
  const m = new RegExp("^create or replace function (?:public[.])?" + name + "[(][^)]*[)][\\s\\S]*?[$][$];", "m").exec(sql);
  expect(m, `${name} not found`).not.toBeNull();
  return m![0];
}

const GUARD = "if coalesce(new.params->>'catalogue', '') = 'true' then";

const TABLES = [
  "curricula",
  "curriculum_nodes",
  "topics",
  "topic_aliases",
  "topic_curriculum_map",
  "topic_candidates",
  "topic_articles",
  "article_figures",
  "topic_kits",
  "topic_publications",
  "topic_questions",
  "question_set_blueprints",
  "question_sets",
];

const CHECKS: Record<string, string[]> = {
  "kind in": ["syllabus", "exam_board"],
  "status in ('candidate'": ["candidate", "approved", "article_approved", "generating", "in_review", "video_approved", "published", "retired"],
  "bank_maturity in": ["none", "basic", "good", "strong", "assessment", "exam_ready"],
  "source in": ["curriculum", "book", "manual"],
  "coverage in": ["full", "partial"],
  "source_kind in": ["book", "curriculum"],
  "status in ('open'": ["open", "merged", "created", "dismissed"],
  "status in ('draft','in_review'": ["draft", "in_review", "approved", "superseded", "rejected"],
  "author in": ["model", "staff"],
  "status in ('draft','rendered'": ["draft", "rendered", "approved", "rejected"],
  "status in ('generating'": ["generating", "in_review", "approved", "rejected", "failed"],
  "reject_reason in": ["factual", "grade_fit", "pacing", "visuals", "pronunciation", "translation", "other"],
  "privacy in": ["private", "unlisted", "public"],
  "item_type in": ["mcq", "true_false", "fill_blank", "match", "assertion_reason", "short_answer", "long_answer", "numerical", "diagram_label"],
  "answer_mode in": ["objective", "subjective"],
  "cognitive_level in": ["recall", "understand", "apply", "analyse", "evaluate", "create"],
  "status in ('draft','approved'": ["draft", "approved", "rejected", "retired"],
  "scope in": ["worksheet", "paper", "mock_exam"],
  "min_maturity in": ["basic", "good", "strong", "assessment", "exam_ready"],
  "status in ('active'": ["active", "retired"],
};

describe("0111 — the enum file", () => {
  it("is exactly one ALTER TYPE and nothing else", () => {
    const c = code(M0111);
    expect(c).toBe("alter type public.artifact_kind add value if not exists 'script_json';");
  });
  it("carries the apply-order warning and the agent-applied line", () => {
    expect(M0111).toContain("APPLY ORDER");
    expect(M0111).toContain("Applied to prod by the agent on the founder's explicit 2026-09-06 instruction, after a rolled-back dry run.");
  });
});

describe("0112 — tables", () => {
  const c = code(M0112);

  it("creates every catalogue table, service-role only", () => {
    for (const t of TABLES) {
      expect(c, t).toContain(`create table if not exists public.${t} (`);
      expect(c, t).toContain(`alter table public.${t} enable row level security;`);
      expect(c, t).toContain(`revoke all on public.${t} from anon, authenticated;`);
    }
    expect(c.toLowerCase()).not.toContain("create policy");
  });

  it("carries exactly the plan's value lists in its check constraints", () => {
    const lists = [...c.matchAll(/(\w+) in \(((?:'[a-z_]+'(?:,\s*)?)+)\)/g)].map((m) => ({
      col: m[1],
      values: m[2].split(",").map((s) => s.trim().replace(/'/g, "")),
      text: m[0],
    }));
    for (const [prefix, expected] of Object.entries(CHECKS)) {
      const hit = lists.find((l) => l.text.replace(/\s+/g, "").startsWith(prefix.replace(/\s+/g, "")));
      expect(hit, prefix).toBeDefined();
      expect(hit!.values, prefix).toEqual(expected);
    }
  });

  it("caps candidate titles at 120 characters — names, never book text", () => {
    expect(c).toContain("raw_title           text not null check (char_length(raw_title) <= 120)");
  });

  it("allows one approved article per topic and language", () => {
    expect(c).toContain("create unique index if not exists topic_articles_one_approved");
    expect(c).toContain("on public.topic_articles (topic_id, language) where status = 'approved';");
  });

  it("dedupes candidates on (source, book, node, normalized) with a unique expression index", () => {
    expect(c).toContain("create unique index if not exists topic_candidates_uniq on public.topic_candidates (");
    expect(c).toContain("coalesce(book_id, '00000000-0000-0000-0000-000000000000'::uuid),");
    expect(c).toContain("coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid),");
  });

  it("puts no foreign key on article_figures.visual_asset_id (worker-owned table)", () => {
    const m = c.match(/visual_asset_id\s+uuid[^,\n]*/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("references");
  });
});

describe("0112 — bank maturity", () => {
  const c = code(M0112);
  it("has the ladder thresholds once each and fires on delete", () => {
    const body = fn(M0112, "topic_bank_maturity");
    for (const n of [100, 50, 30, 20, 10]) {
      // word boundary: ">= 10" must not count ">= 100"
      expect(body.match(new RegExp(">= " + n + "\\b", "g"))?.length ?? 0, `${n}`).toBe(1);
    }
    expect(body).toContain("q.status = 'approved' and q.language = 'en'");
    expect(c).toContain("create trigger topic_questions_maturity after insert or update or delete on public.topic_questions");
    expect(c).toContain("revoke execute on function public.topic_bank_maturity(uuid) from public, anon, authenticated;");
  });
});

describe("0112 — trigger exemptions", () => {
  const cases: [string, string][] = [
    ["reject_double_submit", M0103],
    ["enforce_fair_use", M0103],
    ["credit_ledger_write", M0089],
  ];

  it.each(cases)("%s: the guard is the first statement, before any advisory lock", (name) => {
    const body = fn(M0112, name);
    expect(body.split(GUARD).length - 1).toBe(1);
    const begin = body.indexOf("\nbegin\n");
    const guard = body.indexOf(GUARD);
    expect(begin).toBeGreaterThan(-1);
    // Only comment lines may sit between `begin` and the guard.
    const between = body.slice(begin + "\nbegin\n".length, guard);
    expect(between.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("--"))).toBe(true);
    const lock = body.indexOf("pg_advisory_xact_lock");
    if (lock >= 0) expect(guard).toBeLessThan(lock);
    const guardBlock = body.slice(guard, guard + 400);
    // params is client-writable: the flag alone must never open the door.
    expect(guardBlock).toContain("if not public.is_platform_admin(new.owner_id) then");
    expect(guardBlock).toContain("raise exception 'params.catalogue is reserved for the catalogue system account.';");
    expect(guardBlock).toContain("return new;");
  });

  it.each(cases)("%s: minus the guard, the body is the last defining migration's body", (name, prior) => {
    const mine = code(fn(M0112, name))
      .split("\n")
      .filter(
        (l) =>
          !l.includes("'catalogue'") &&
          !l.includes("params.catalogue") &&
          !l.includes("is_platform_admin(new.owner_id)") &&
          l.trim() !== "return new;" &&
          l.trim() !== "end if;",
      )
      .join("\n");
    // The prior body loses the same two token kinds so the comparison is fair:
    // the guard contributes `return new;` and `end if;` lines and nothing else
    // that survives the filters above.
    const theirs = code(fn(prior, name))
      .split("\n")
      .filter((l) => l.trim() !== "return new;" && l.trim() !== "end if;")
      .join("\n");
    expect(mine).toBe(theirs);
  });

  it("does not redefine the billing or tier functions (free-ride guarantee)", () => {
    for (const name of ["fair_use_used", "fair_use_used_since", "credit_ledger_sync", "credit_ledger_void_unconsumed", "plan_tier", "fair_use_caps", "premium_voices_allowed", "enforce_beta_generation_cap", "enforce_lesson_tools"]) {
      expect(M0112).not.toMatch(new RegExp("create or replace function (?:public[.])?" + name + "[(]"));
    }
    expect(code(M0112).toLowerCase()).not.toContain("alter type");
  });
});

describe("0112 — writes and shape", () => {
  const c = code(M0112);
  it("inserts only the worksheet presets, idempotently", () => {
    const inserts = [...c.matchAll(/insert into public\.(\w+)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["question_set_blueprints"]);
    expect(c).toContain("on conflict (name) do nothing;");
    expect(c.split("'Remedial ·").length - 1).toBe(4);
    expect(c.split("'Standard ·").length - 1).toBe(4);
    expect(c.split("'Challenge ·").length - 1).toBe(4);
    expect(c.toLowerCase()).not.toContain("update public.");
  });
  it("is one transaction and carries the agent-applied line", () => {
    expect(c.startsWith("begin;")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
    expect(M0112).toContain("Applied to prod by the agent on the founder's explicit 2026-09-06 instruction, after a rolled-back dry run.");
  });
});
