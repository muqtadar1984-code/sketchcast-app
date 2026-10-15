// SketchCast AI — 0128 concurrency check: two sessions racing one weekly cap.
//
// A single-transaction SQL test cannot race itself, so this drives TWO
// connections. It needs a NON-PRODUCTION database with 0128 applied (it
// commits fixture rows, then deletes them). Exported as a function so a
// runner can hand it a connection factory:
//   await check({ connect: async () => <connected pg.Client> })
//
// Proves:
//   1. a free user with NO prior unlock rows fires two unlocks for different
//      topics at once: exactly one is 'unlocked', the other 'weekly_limit';
//   2. two unlocks of the SAME topic at once: one 'unlocked', one 'already',
//      and one row;
//   3. the advisory lock is load-bearing: with it removed, the same race lets
//      BOTH through (then the real function is restored and re-checked).

const U = "33333333-0128-0000-0000-0000000000c1";
const U2 = "33333333-0128-0000-0000-0000000000c2";
const U3 = "33333333-0128-0000-0000-0000000000c3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(c) {
  await c.query(`
    insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
    select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', u::text || '@conc0128.example.com', now(), now()
    from unnest(array['${U}','${U2}','${U3}']::uuid[]) u on conflict (id) do nothing;
    insert into profiles (id, role) select u, 'teacher' from unnest(array['${U}','${U2}','${U3}']::uuid[]) u
      on conflict (id) do update set role = 'teacher', school_id = null, suspended_at = null;
  `);
  const ids = [];
  for (const k of ["ca", "cb"]) {
    const { rows } = await c.query(`
      with t as (insert into topics (canonical_key, title, subject, status, bank_maturity)
                 values ('zz-0128-conc-${k}', 'ZZ 0128 conc ${k}', 'Science', 'video_approved', 'good') returning id),
           a as (insert into topic_articles (topic_id, title, status) select id, 'a', 'approved' from t returning id, topic_id),
           kit as (insert into topic_kits (topic_id, article_id, language, status, reviewed_at)
                   select topic_id, id, 'en', 'approved', now() from a returning id, topic_id),
           p as (insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy)
                 select id, 1, 'en', 'yt_conc_${k}', 'public' from kit returning 1)
      select topic_id from kit, (select count(*) from p) _`);
    ids.push(rows[0].topic_id);
  }
  return ids;
}

async function cleanup(c) {
  await c.query(`
    delete from catalogue_events  where user_id in ('${U}','${U2}','${U3}');
    delete from catalogue_unlocks where user_id in ('${U}','${U2}','${U3}');
    delete from topics where canonical_key like 'zz-0128-conc-%';
    delete from profiles where id in ('${U}','${U2}','${U3}');
    delete from auth.users where id in ('${U}','${U2}','${U3}');`);
}

// Session A unlocks and HOLDS its transaction open; session B's unlock is
// issued while A is open; then A commits. Returns [statusA, statusB].
async function race(connect, user, topicA, topicB) {
  const a = await connect();
  const b = await connect();
  try {
    const claims = JSON.stringify({ sub: user, role: "authenticated" });
    for (const s of [a, b]) {
      await s.query("begin");
      await s.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    }
    const ra = await a.query("select unlock_catalogue_kit($1) ->> 'status' as s", [topicA]);
    const pb = b.query("select unlock_catalogue_kit($1) ->> 'status' as s", [topicB]);
    await sleep(400); // B is now either blocked on A's lock, or already done
    await a.query("commit");
    const rb = await pb;
    await b.query("commit");
    return [ra.rows[0].s, rb.rows[0].s];
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  PASS: " + msg);
}

export default async function check({ connect }) {
  const c = await connect();
  let original = null;
  try {
    await cleanup(c);
    const [ta, tb] = await setup(c);

    // 1. first-ever unlocks, different topics, at once
    const r1 = await race(connect, U, ta, tb);
    expect(r1.filter((s) => s === "unlocked").length === 1 && r1.includes("weekly_limit"),
      `no prior rows, two topics at once -> one unlocked, one weekly_limit (${r1})`);
    const n1 = (await c.query(`select count(*)::int n from catalogue_unlocks where user_id = $1`, [U])).rows[0].n;
    expect(n1 === 1, `exactly one unlock row persisted (${n1})`);

    // 2. same topic at once
    const r2 = await race(connect, U2, ta, ta);
    expect(r2.includes("unlocked") && r2.includes("already"), `same topic twice at once -> unlocked + already (${r2})`);
    const n2 = (await c.query(`select count(*)::int n from catalogue_unlocks where user_id = $1`, [U2])).rows[0].n;
    expect(n2 === 1, `one row for the same topic (${n2})`);

    // 3. prove the lock is load-bearing: remove it, race again, expect BOTH through
    original = (await c.query(`select pg_get_functiondef('public.unlock_catalogue_kit(uuid)'::regprocedure) d`)).rows[0].d;
    const unlocked = original.replace(/perform pg_advisory_xact_lock\([^;]*\);/, "perform pg_sleep(0.2);");
    if (unlocked === original) throw new Error("could not find the advisory lock to remove");
    await c.query(unlocked);
    const r3 = await race(connect, U3, ta, tb);
    expect(r3[0] === "unlocked" && r3[1] === "unlocked",
      `WITHOUT the lock the same race over-spends the cap (${r3}) — the lock is what prevents it`);
  } finally {
    if (original) {
      await c.query(original);
      const back = (await c.query(`select pg_get_functiondef('public.unlock_catalogue_kit(uuid)'::regprocedure) d`)).rows[0].d;
      expect(back.includes("pg_advisory_xact_lock"), "real function restored (lock present again)");
    }
    await cleanup(c);
    await c.end();
  }
}
