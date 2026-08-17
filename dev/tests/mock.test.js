/* ============================================================================
   Blueprint — mock backend + integration tests.  Run: node dev/tests/mock.test.js
   These exercise the flows that matter end to end against the mock, so the
   provisioning path and its authorization rules are verified before any UI
   depends on them.
   ========================================================================== */
const BP = require("../../core.js");
const { createMockClient } = require("../mock-db.js");

let pass = 0, fail = 0;
const fails = [];
const ok = (c, l) => { c ? pass++ : (fail++, fails.push(l)); };
const eq = (a, e, l) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  ok(A === E, l + "\n      expected: " + E + "\n      actual:   " + A);
};
const group = (n, fn) => { console.log("\n  " + n); return fn(); };

const NOW = Date.parse("2026-08-17T12:00:00Z");
const mk = () => createMockClient({ now: NOW });

(async function () {

  await group("mock client mirrors the supabase-js shape", async () => {
    const sb = mk();
    const { data, error } = await sb.from("hub_apps").select();
    ok(error === null, "select returns error:null");
    ok(Array.isArray(data), "select returns an array");
    eq(data.length, 4, "four apps seeded");

    const one = await sb.from("hub_apps").select().eq("slug", "lennar-map").maybeSingle();
    eq(one.data.name, "Community Map", "eq + maybeSingle");

    const missing = await sb.from("hub_apps").select().eq("slug", "nope").maybeSingle();
    eq(missing.data, null, "maybeSingle on no match → null, not an error");

    const bad = await sb.rpc("does_not_exist", {});
    ok(/does not exist/.test(bad.error.message), "unknown rpc errors like postgres");
  });

  await group("app registry ordering matches core.js", async () => {
    const sb = mk();
    const { data } = await sb.from("hub_apps").select();
    eq(BP.sortApps(data).map(a => a.name),
       ["Community-DB", "Community Map", "Takeoff Flow", "Vendor Assignments"],
       "seeded apps sort correctly");
    eq(BP.managedApps(data).map(a => a.name),
       ["Community-DB", "Takeoff Flow", "Vendor Assignments"],
       "map excluded from managed");
  });

  await group("users merge across three role tables", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");
    const { data: apps } = await sb.from("hub_apps").select();

    const rolesByApp = {};
    for (const app of BP.managedApps(apps)) {
      const { data } = await sb.rpc(app.list_rpc);
      rolesByApp[app.slug] = data;
    }
    const lastSignIn = {};
    for (const u of (await sb.from("auth_users").select()).data) {
      lastSignIn[u.email] = u.last_sign_in_at;
    }

    const rows = BP.mergeUsers(rolesByApp, apps, { lastSignIn });
    eq(rows.length, 8, "eight accounts");

    const jen = rows.find(r => r.email === "jordan.blake@lennar.com");
    eq(jen.roles["Vendor-Portal"].role, "editor", "Jennifer: editor in Vendor Assignments");
    eq(jen.roles["Takeoff-Flow"].role, "purchasing", "Jennifer: purchasing in Takeoff Flow");
    eq(jen.roles["Community-DB"].explicit, false, "Jennifer: implicit viewer in Community-DB");

    const marcus = rows.find(r => r.email === "sam.ellis@lennar.com");
    eq(BP.explicitRoleCount(marcus), 0, "Marcus has no explicit roles anywhere");
    eq(marcus.lastSignIn, null, "and has never signed in");

    const admins = rows.filter(BP.isAdminAnywhere).map(r => r.email);
    eq(admins, ["avery.stone@lennar.com", "taylor.reed@lennar.com"], "two admins, sorted");
    eq(BP.adminSlugs(rows.find(r => r.email === "taylor.reed@lennar.com")),
       ["Community-DB"], "Denis is admin in Community-DB only");
  });

  await group("minting authorization is per role table", async () => {
    const sb = mk();
    const { data: apps } = await sb.from("hub_apps").select();

    // Denis is a Community-DB admin only.
    sb.__signInAs("taylor.reed@lennar.com");
    const denisAdmin = ["Community-DB"];

    const poolA = BP.chooseMintRpc("A", apps, denisAdmin);
    ok(!poolA.ok, "Denis cannot mint pool A — no VA/TF admin row");
    const attempted = await sb.rpc("admin_add_or_reset", { target_email: "new@lennar.com" });
    ok(/not authorized/.test(attempted.error.message), "and the RPC refuses him too — mock enforces it");

    const poolB = BP.chooseMintRpc("B", apps, denisAdmin);
    ok(poolB.ok && poolB.rpc === "cdb_admin_add_or_reset", "but he can mint pool B");
    const minted = await sb.rpc(poolB.rpc, { target_email: "new@lennar.com" });
    ok(minted.data.ok && minted.data.token, "pool B token minted");
    eq(minted.data.created, true, "new account created");

    // Steve is admin everywhere.
    sb.__signInAs("avery.stone@lennar.com");
    const steveA = BP.chooseMintRpc("A", apps, ["Community-DB", "Takeoff-Flow", "Vendor-Portal"]);
    ok(steveA.ok, "Steve can mint pool A");
    const r = await sb.rpc(steveA.rpc, { target_email: "another@lennar.com" });
    ok(r.data.ok, "and it succeeds");
  });

  await group("full provisioning: one link covers two pool-A apps", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");
    const { data: apps } = await sb.from("hub_apps").select();
    const adminOf = ["Community-DB", "Takeoff-Flow", "Vendor-Portal"];

    const plan = BP.buildGrantPlan({
      grants: {
        "Vendor-Portal": { enabled: true, role: "editor", divisions: ["tampa", "orlando"] },
        "Takeoff-Flow": { enabled: true, role: "purchasing", divisions: ["tampa"] },
        "Community-DB": { enabled: false }
      }
    }, apps);
    ok(plan.ok, "grant plan builds");

    const pools = BP.poolsForGrants(plan.grants);
    eq(pools, ["A"], "two pool-A grants need exactly one link");

    // write the role rows
    for (const g of plan.grants) {
      const row = { email: "sam.ellis@lennar.com", role: g.role };
      if (g.divisions.length) row.divisions = g.divisions;
      const { error } = await sb.from(g.roleTable).upsert(row, { onConflict: "email" });
      ok(!error, "role row written to " + g.roleTable);
    }

    // mint one token, build one Blueprint link
    const choice = BP.chooseMintRpc("A", apps, adminOf);
    const { data } = await sb.rpc(choice.rpc, { target_email: "sam.ellis@lennar.com" });
    const url = BP.buildRecoverUrl("https://ssvedman.github.io/blueprint/", data.token, "A");
    ok(url.startsWith("https://ssvedman.github.io/blueprint/#recover="), "link lands on Blueprint");
    ok(!url.includes("pool="), "pool A link carries no tag");

    // redeem it the way Blueprint will
    const parsed = BP.parseRecoverHash(url.slice(url.indexOf("#")));
    eq(parsed.pool, "A", "parsed back as pool A");
    const redeemed = await sb.rpc("redeem_reset_token", {
      p_token: parsed.token, p_new_password: "correct-horse"
    });
    ok(redeemed.data.ok, "redemption succeeds");

    // the roles landed, and remained asymmetric
    const va = (await sb.from("app_roles").select().eq("email", "sam.ellis@lennar.com").maybeSingle()).data;
    const tf = (await sb.from("tf_app_roles").select().eq("email", "sam.ellis@lennar.com").maybeSingle()).data;
    eq(va.role, "editor", "Vendor Assignments: editor");
    eq(tf.role, "purchasing", "Takeoff Flow: purchasing");
    ok(va.role !== tf.role, "roles stayed independent through provisioning");
    const cdb = (await sb.from("cdb_app_roles").select().eq("email", "sam.ellis@lennar.com").maybeSingle()).data;
    eq(cdb, null, "ungranted app got no row at all");
  });

  await group("granting Community-DB requires a second link", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");
    const { data: apps } = await sb.from("hub_apps").select();

    const plan = BP.buildGrantPlan({
      grants: {
        "Vendor-Portal": { enabled: true, role: "viewer" },
        "Community-DB": { enabled: true, role: "editor" }
      }
    }, apps);
    eq(BP.poolsForGrants(plan.grants), ["A", "B"], "two pools → two links");

    const links = [];
    for (const pool of BP.poolsForGrants(plan.grants)) {
      const c = BP.chooseMintRpc(pool, apps, ["Community-DB", "Takeoff-Flow", "Vendor-Portal"]);
      const { data } = await sb.rpc(c.rpc, { target_email: "sam.ellis@lennar.com" });
      links.push(BP.buildRecoverUrl("https://ssvedman.github.io/blueprint/", data.token, pool));
    }
    eq(links.length, 2, "two links generated");
    ok(links.every(l => l.includes("/blueprint/#recover=")), "both land on Blueprint");
    eq(links.filter(l => l.includes("&pool=cdb")).length, 1, "exactly one is tagged cdb");

    // Blueprint must route each to the right redeem function.
    for (const link of links) {
      const p = BP.parseRecoverHash(link.slice(link.indexOf("#")));
      const rpc = p.pool === "B" ? "cdb_redeem_reset_token" : "redeem_reset_token";
      const res = await sb.rpc(rpc, { p_token: p.token, p_new_password: "hunter2hunter2" });
      ok(res.data.ok, "pool " + p.pool + " redeemed via " + rpc);
    }
  });

  await group("redemption failure modes", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");

    const reused = await sb.rpc("redeem_reset_token", {
      p_token: "9f3ab7712cc40d51", p_new_password: "longenough1"
    });
    ok(/already used/.test(reused.data.error), "already-used token refused");

    const expired = await sb.rpc("redeem_reset_token", {
      p_token: "e7c1b9042daf6835", p_new_password: "longenough1"
    });
    ok(/expired/.test(expired.data.error), "expired token refused");

    const short = await sb.rpc("redeem_reset_token", {
      p_token: "a41f9c7e2b08d5136ea0f7c4", p_new_password: "abc"
    });
    ok(/8 characters/.test(short.data.error), "short password refused");

    const wrongPool = await sb.rpc("redeem_reset_token", {
      p_token: "bb20f61c9e7a4d33", p_new_password: "longenough1"
    });
    ok(/Invalid link/.test(wrongPool.data.error),
       "a pool B token offered to pool A's function is rejected — why the &pool tag exists");

    const bogus = await sb.rpc("cdb_redeem_reset_token", {
      p_token: "nonsense", p_new_password: "longenough1"
    });
    ok(/Invalid link/.test(bogus.data.error), "unknown token refused");
  });

  await group("hub_pending_invites never returns tokens", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");
    const { data } = await sb.rpc("hub_pending_invites");

    ok(Array.isArray(data), "returns rows");
    ok(data.length > 0, "there are pending invites");
    const leaked = data.filter(r => "token" in r);
    eq(leaked, [], "no row contains a token column — the security property");
    eq(Object.keys(data[0]).sort(), ["created_at", "email", "expires_at", "pool"],
       "exactly the four safe columns");

    // Pool B expiry is computed, not stored.
    const b = data.find(r => r.pool === "B");
    const exp = BP.tokenExpiry({ created_at: b.created_at }, NOW);
    eq(new Date(b.expires_at).toISOString(), exp.expiresAt.toISOString(),
       "SQL-side and client-side pool B expiry agree");

    // and it is admin-gated
    sb.__signInAs("sam.ellis@lennar.com");
    const denied = await sb.rpc("hub_pending_invites");
    ok(/not authorized/.test(denied.error.message), "non-admin is refused");
  });

  await group("removing an app never revokes access", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");

    const before = (await sb.from("app_roles").select()).data.length;
    const app = (await sb.from("hub_apps").select().eq("slug", "Vendor-Portal").maybeSingle()).data;

    const impact = BP.removalImpact(app);
    ok(impact.roleTableTouched === false, "impact says role table untouched");

    await sb.from("hub_apps").delete().eq("slug", "Vendor-Portal");

    const apps = (await sb.from("hub_apps").select()).data;
    eq(apps.length, 3, "registry row gone");
    ok(!apps.some(a => a.slug === "Vendor-Portal"), "and it is the right one");

    const after = (await sb.from("app_roles").select()).data.length;
    eq(after, before, "app_roles is completely untouched — nobody lost access");
    eq(after, 3, "still three role rows");
  });

  await group("adding an app is launcher-only by construction", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");
    const existing = (await sb.from("hub_apps").select()).data;

    const v = BP.validateNewApp({
      name: "Plan Library", url: "https://ssvedman.github.io/plan-library",
      description: "Plan sets by community.", authors: "Stephen Svedman"
    }, existing);
    ok(v.ok, "validates");

    const { error } = await sb.from("hub_apps").upsert(v.app, { onConflict: "slug" });
    ok(!error, "inserted");

    const apps = (await sb.from("hub_apps").select()).data;
    eq(apps.length, 5, "five apps now");
    eq(BP.sortApps(apps).map(a => a.name),
       ["Community-DB", "Community Map", "Plan Library", "Takeoff Flow", "Vendor Assignments"],
       "sorts into the right alphabetical position");

    const added = apps.find(a => a.slug === "plan-library");
    eq(added.role_table, null, "no role table — cannot appear in Users/Provision");
    ok(!BP.isManaged(added), "so it is not managed");

    // and the wiring fields cannot be set through the editable path
    eq(BP.pickEditable({ name: "X", role_table: "app_roles" }), { name: "X" },
       "an attempt to set role_table via edit is dropped");
  });

  await group("array columns are type-checked like Postgres", async () => {
    const sb = mk();
    sb.__signInAs("avery.stone@lennar.com");

    // This is the shape that failed in production. The mock used to accept it,
    // which is why the test suite passed while the live edit errored.
    const bad = await sb.from("hub_apps")
      .update({ authors: "Denis Crepes, Stephen Svedman" }).eq("slug", "Community-DB");
    ok(bad.error && /malformed array literal/.test(bad.error.message),
       "a string sent to a text[] column is rejected, as Postgres would");

    const good = await sb.from("hub_apps")
      .update({ authors: ["Denis Crepes", "Stephen Svedman"] }).eq("slug", "Community-DB");
    ok(!good.error, "an array is accepted");
    const row = (await sb.from("hub_apps").select().eq("slug", "Community-DB").maybeSingle()).data;
    eq(row.authors, ["Denis Crepes", "Stephen Svedman"], "and stored as an array");

    eq((await sb.from("hub_apps").update({ description: "fine" }).eq("slug", "Community-DB")).error,
       null, "non-array columns unaffected");
  });

  await group("auth", async () => {
    const sb = mk();
    const bad = await sb.auth.signInWithPassword({ email: "nobody@lennar.com", password: "whatever" });
    ok(bad.error, "unknown user refused");
    const good = await sb.auth.signInWithPassword({
      email: "Avery.Stone@lennar.com", password: "localdev"
    });
    ok(!good.error && good.data.user.email === "avery.stone@lennar.com", "sign-in normalizes email");
    const s = await sb.auth.getSession();
    ok(s.data.session, "session present");
    await sb.auth.signOut();
    ok(!(await sb.auth.getSession()).data.session, "signed out");
  });

  console.log("\n" + "─".repeat(64));
  if (fail) {
    console.log("  FAILED\n");
    fails.forEach(f => console.log("   ✗ " + f));
    console.log("\n  " + pass + " passed, " + fail + " failed");
    process.exit(1);
  } else {
    console.log("  ✓ all " + pass + " assertions passed");
    process.exit(0);
  }
})();
