/* ============================================================================
   Blueprint — core logic tests.   Run:  node dev/tests/core.test.js
   No framework: a tiny assert harness keeps this dependency-free so it runs
   anywhere node exists.
   ========================================================================== */
const BP = require("../../core.js");

let pass = 0, fail = 0;
const fails = [];

function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; fails.push(label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label + "\n      expected: " + e + "\n      actual:   " + a);
}
function group(name, fn) { console.log("\n  " + name); fn(); }

/* ---------------------------------------------------------------- fixtures */

const APPS = [
  { slug: "Vendor-Portal", name: "Vendor Assignments", url: "https://ssvedman.github.io/Vendor-Portal/",
    role_table: "app_roles", list_rpc: "admin_list_users", token_rpc: "admin_add_or_reset",
    token_pool: "A", roles: ["admin", "editor", "viewer"], division_scoped_roles: ["editor"],
    authors: ["Stephen Svedman"], active: true },
  { slug: "Takeoff-Flow", name: "Takeoff Flow", url: "https://ssvedman.github.io/Takeoff-Flow/",
    role_table: "tf_app_roles", list_rpc: "tf_admin_list_users", token_rpc: "tf_admin_add_or_reset",
    token_pool: "A", roles: ["admin", "editor", "purchasing", "viewer"],
    division_scoped_roles: ["editor", "purchasing"], authors: ["Stephen Svedman"], active: true },
  { slug: "Community-DB", name: "Community-DB", url: "https://ssvedman.github.io/Community-DB/",
    role_table: "cdb_app_roles", list_rpc: "cdb_admin_list_users", token_rpc: "cdb_admin_add_or_reset",
    token_pool: "B", roles: ["admin", "editor", "viewer"], division_scoped_roles: [],
    authors: ["Denis Crepes", "Stephen Svedman"], active: true },
  { slug: "lennar-map", name: "Community Map", url: "https://grant-slater.github.io/lennar-map/",
    role_table: null, list_rpc: null, token_rpc: null, token_pool: null, roles: [],
    authors: ["Grant Slater"], active: true }
];

/* ------------------------------------------------------------------- tests */

group("ordering", () => {
  eq(BP.sortApps(APPS).map(a => a.name),
     ["Community-DB", "Community Map", "Takeoff Flow", "Vendor Assignments"],
     "apps sort alphabetically, punctuation-insensitive");

  // The whole reason for the custom collator: a naive compare puts
  // "Community Map" first because U+0020 < U+002D.
  const naive = APPS.map(a => a.name).sort();
  ok(naive[0] === "Community Map",
     "sanity: naive sort really does order Community Map first (naive[0]=" + naive[0] + ")");
  ok(BP.sortApps(APPS)[0].name === "Community-DB",
     "collator corrects the naive ordering");

  eq(BP.sortApps([{ name: "b" }, { name: "A" }, { name: "a" }]).map(x => x.name),
     ["A", "a", "b"], "case-insensitive ordering is stable");

  eq(BP.sortEmails(["zed@x.com", { email: "Amy@X.com" }, "mia@x.com"]).map(BP => BP.email || BP),
     ["Amy@X.com", "mia@x.com", "zed@x.com"], "emails sort, objects or strings");
});

group("app registry", () => {
  eq(BP.managedApps(APPS).map(a => a.slug),
     ["Community-DB", "Takeoff-Flow", "Vendor-Portal"], "managed = has role_table, sorted");
  ok(!BP.isManaged(APPS[3]), "map is not managed");
  eq(BP.activeApps(APPS.concat([{ name: "Old", active: false }])).map(a => a.name),
     ["Community-DB", "Community Map", "Takeoff Flow", "Vendor Assignments"],
     "inactive apps excluded");

  eq(BP.slugify("Plan Library"), "plan-library", "slugify");
  eq(BP.slugify("  Weird!! Name??  "), "weird-name", "slugify strips punctuation");

  // Wiring fields must never be writable from the UI.
  const patch = { name: "X", role_table: "app_roles", token_rpc: "evil", active: false };
  eq(BP.pickEditable(patch), { name: "X", active: false }, "pickEditable drops wiring fields");
  eq(BP.rejectedFields(patch), ["role_table", "token_rpc"], "rejectedFields names them");
});

group("removal is registry-only", () => {
  const managed = BP.removalImpact(APPS[0]);
  ok(managed.registryRowDeleted, "registry row is deleted");
  ok(managed.roleTableTouched === false, "role table is NOT touched");
  eq(managed.usersLosingAccess, 0, "nobody loses access when a managed app is removed");
  ok(managed.appKeepsRunning, "the app itself keeps running");
  ok(/app_roles is untouched/.test(managed.note), "note names the spared role table");

  const launcher = BP.removalImpact(APPS[3]);
  eq(launcher.roleTable, null, "launcher-only app has no role table");
  eq(launcher.usersLosingAccess, 0, "and still costs nobody access");
});

group("validation", () => {
  ok(BP.validateEmail("Avery@Lennar.com", "@lennar.com").ok, "valid lennar email");
  eq(BP.validateEmail("Avery@Lennar.com", "@lennar.com").email, "avery@lennar.com", "normalized");
  ok(!BP.validateEmail("nope@gmail.com", "@lennar.com").ok, "wrong domain rejected");
  ok(!BP.validateEmail("notanemail", "@lennar.com").ok, "malformed rejected");
  ok(!BP.validateEmail("a two@lennar.com", "@lennar.com").ok, "spaces rejected");
  ok(!BP.validateEmail("", "@lennar.com").ok, "empty rejected");

  ok(!BP.validateUrl("http://x.com").ok, "http rejected — https only");
  eq(BP.validateUrl("https://x.com/app").url, "https://x.com/app/", "trailing slash added");

  // Name collision, even though slugify("Community Map") = "community-map"
  // does not clash with the existing "lennar-map" slug.
  const dupName = BP.validateNewApp({ name: "Community Map", url: "https://a.com/" }, APPS);
  ok(!dupName.ok && /named "Community Map" already exists/.test(dupName.errors.join()),
     "duplicate NAME rejected even when the slug differs");
  const dupCase = BP.validateNewApp({ name: "community map", url: "https://a.com/" }, APPS);
  ok(!dupCase.ok, "name collision is case-insensitive");
  const dupSlug = BP.validateNewApp({ name: "Lennar Map", url: "https://a.com/" }, APPS);
  ok(!dupSlug.ok && /slug "lennar-map" already exists/.test(dupSlug.errors.join()),
     "duplicate SLUG rejected even when the name differs");

  const good = BP.validateNewApp(
    { name: "Plan Library", url: "https://ssvedman.github.io/plan-library", authors: "Stephen Svedman" },
    APPS);
  ok(good.ok, "valid new app accepted");
  eq(good.app.role_table, null, "new app is launcher-only: no role_table");
  eq(good.app.token_pool, null, "new app mints no tokens");
  eq(good.app.authors, ["Stephen Svedman"], "authors parsed");
});

group("authors", () => {
  eq(BP.formatAuthors(["Denis Crepes", "Stephen Svedman"]), "Denis Crepes and Stephen Svedman", "two");
  eq(BP.formatAuthors("A, B, C"), "A, B and C", "three from CSV");
  eq(BP.formatAuthors([]), "—", "none");
  eq(BP.initialsOf("Stephen Svedman"), "SS", "initials");
  eq(BP.initialsOf("Grant Slater"), "GS", "initials 2");
  eq(BP.initialsOf("Cher"), "CH", "single name");
});

group("role merge — independence preserved", () => {
  const rolesByApp = {
    "Vendor-Portal": [
      { email: "avery@lennar.com", role: "admin", divisions: [] },
      { email: "jordan@lennar.com", role: "editor", divisions: ["tampa"] }
    ],
    "Takeoff-Flow": [
      { email: "avery@lennar.com", role: "admin", divisions: [] },
      { email: "jordan@lennar.com", role: "purchasing", divisions: ["tampa"] },
      { email: "riley@lennar.com", role: "purchasing", divisions: ["orlando"] }
    ],
    "Community-DB": [
      { email: "avery@lennar.com", role: "admin", divisions: [] }
    ]
  };
  const rows = BP.mergeUsers(rolesByApp, APPS, { lastSignIn: { "avery@lennar.com": "2026-08-17" } });

  eq(rows.map(r => r.email), ["avery@lennar.com", "jordan@lennar.com", "riley@lennar.com"],
     "one row per person, sorted");

  const jordan = rows.find(r => r.email === "jordan@lennar.com");
  eq(jordan.roles["Vendor-Portal"].role, "editor", "jen is editor in Vendor Assignments");
  eq(jordan.roles["Takeoff-Flow"].role, "purchasing", "and purchasing in Takeoff Flow");
  ok(jordan.roles["Vendor-Portal"].role !== jordan.roles["Takeoff-Flow"].role,
     "asymmetric roles survive the merge — this is the point");

  eq(jordan.roles["Community-DB"].explicit, false, "no CDB row → implicit");
  eq(jordan.roles["Community-DB"].role, "viewer", "implicit means viewer");
  eq(BP.explicitRoleCount(jordan), 2, "jordan has 2 explicit roles");

  ok(!("lennar-map" in jordan.roles), "unmanaged app gets no role column at all");

  ok(BP.isAdminAnywhere(rows.find(r => r.email === "avery@lennar.com")), "avery is admin");
  ok(!BP.isAdminAnywhere(jordan), "jordan is not");
  eq(BP.adminSlugs(rows.find(r => r.email === "avery@lennar.com")),
     ["Community-DB", "Takeoff-Flow", "Vendor-Portal"], "admin slugs sorted");

  eq(BP.filterUsers(rows, "purchasing").map(r => r.email),
     ["jordan@lennar.com", "riley@lennar.com"], "filter by role");
  eq(BP.filterUsers(rows, "orlando").map(r => r.email), ["riley@lennar.com"], "filter by division");
});

group("grant plan — explicit opt-in only", () => {
  const none = BP.buildGrantPlan({ grants: {} }, APPS);
  eq(none.grants, [], "nothing granted by default");

  const plan = BP.buildGrantPlan({
    grants: {
      "Vendor-Portal": { enabled: true, role: "editor", divisions: ["tampa", "orlando"] },
      "Takeoff-Flow": { enabled: true, role: "purchasing", divisions: ["tampa"] },
      "Community-DB": { enabled: false, role: "editor" }
    }
  }, APPS);
  ok(plan.ok, "plan builds");
  eq(plan.grants.map(g => g.slug), ["Takeoff-Flow", "Vendor-Portal"], "only enabled apps, sorted");
  eq(plan.grants.find(g => g.slug === "Vendor-Portal").divisions, ["tampa", "orlando"],
     "divisions kept for a division-scoped role");

  const global = BP.buildGrantPlan({
    grants: { "Community-DB": { enabled: true, role: "editor", divisions: ["tampa"] } }
  }, APPS);
  eq(global.grants[0].divisions, [], "CDB roles are global — divisions discarded");

  const bad = BP.buildGrantPlan({
    grants: { "Vendor-Portal": { enabled: true, role: "purchasing" } }
  }, APPS);
  ok(!bad.ok, "role not valid for that app is rejected");
});

group("token pools", () => {
  const aOnly = BP.buildGrantPlan({
    grants: { "Vendor-Portal": { enabled: true, role: "editor" },
              "Takeoff-Flow": { enabled: true, role: "viewer" } }
  }, APPS).grants;
  eq(BP.poolsForGrants(aOnly), ["A"], "two pool-A apps need ONE link, not two");

  const both = BP.buildGrantPlan({
    grants: { "Vendor-Portal": { enabled: true, role: "editor" },
              "Community-DB": { enabled: true, role: "viewer" } }
  }, APPS).grants;
  eq(BP.poolsForGrants(both), ["A", "B"], "adding CDB requires a second link");
});

group("mint RPC follows the operator's admin rights", () => {
  const tfAdmin = BP.chooseMintRpc("A", APPS, ["Takeoff-Flow"]);
  ok(tfAdmin.ok, "a Takeoff-Flow-only admin can still mint pool A");
  eq(tfAdmin.rpc, "tf_admin_add_or_reset", "via the RPC they are authorized for");

  const vaAdmin = BP.chooseMintRpc("A", APPS, ["Vendor-Portal"]);
  eq(vaAdmin.rpc, "admin_add_or_reset", "a Vendor-Portal admin uses its own RPC");

  const noAdmin = BP.chooseMintRpc("A", APPS, ["Community-DB"]);
  ok(!noAdmin.ok, "CDB-only admin cannot mint pool A");
  ok(/not an admin/.test(noAdmin.error), "and is told why");

  eq(BP.chooseMintRpc("B", APPS, ["Community-DB"]).rpc, "cdb_admin_add_or_reset", "pool B");
});

group("recover links always land on Blueprint", () => {
  const base = "https://ssvedman.github.io/blueprint/";
  eq(BP.buildRecoverUrl(base, "abc123", "A"), base + "#recover=abc123", "pool A untagged");
  eq(BP.buildRecoverUrl(base, "abc123", "B"), base + "#recover=abc123&pool=cdb", "pool B tagged");
  eq(BP.buildRecoverUrl("https://ssvedman.github.io/blueprint", "t", "A"),
     base + "#recover=t", "missing trailing slash handled");

  // The existing apps parse /[#&]recover=([^&]+)/ which stops at '&', so the
  // pool tag must not corrupt the token for them.
  const legacy = h => { const m = h.match(/[#&]recover=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; };
  eq(legacy("#recover=abc123&pool=cdb"), "abc123", "legacy parser ignores the tag (backward compatible)");

  eq(BP.parseRecoverHash("#recover=abc123"), { token: "abc123", pool: "A" }, "parse untagged → pool A");
  eq(BP.parseRecoverHash("#recover=abc123&pool=cdb"), { token: "abc123", pool: "B" }, "parse cdb tag → pool B");
  eq(BP.parseRecoverHash("#recover=t&pool=nonsense"), { token: "t", pool: "A" },
     "unknown tag degrades to pool A rather than throwing");
  eq(BP.parseRecoverHash("#nothing"), null, "no token");

  // Round-trip: whatever we build must parse back to the same pool.
  for (const pool of ["A", "B"]) {
    eq(BP.parseRecoverHash(BP.buildRecoverUrl(base, "tok", pool)).pool, pool,
       "round-trips pool " + pool);
  }
});

group("token expiry", () => {
  const now = "2026-08-17T12:00:00Z";
  const poolA = BP.tokenExpiry({ created_at: "2026-08-17T06:00:00Z", expires_at: "2026-08-18T06:00:00Z" }, now);
  eq(poolA.computed, false, "pool A expiry is read, not computed");
  eq(poolA.hoursRemaining, 18, "18h left");
  ok(!poolA.expired, "not expired");

  // Pool B has no expires_at column; 14 days is hardcoded in the SQL function.
  const poolB = BP.tokenExpiry({ created_at: "2026-08-10T12:00:00Z" }, now);
  eq(poolB.computed, true, "pool B expiry is computed from created_at");
  eq(poolB.expiresAt.toISOString(), "2026-08-24T12:00:00.000Z", "created_at + 14 days");
  ok(!poolB.expired, "still valid at day 7");

  ok(BP.tokenExpiry({ created_at: "2026-07-01T12:00:00Z" }, now).expired, "old pool B token expired");
  eq(BP.tokenExpiry({}, now), null, "no dates → null");

  const rows = [
    { email: "one@lennar.com", created_at: "2026-08-16T12:00:00Z", used_at: null },
    { email: "two@lennar.com", created_at: "2026-08-16T12:00:00Z", used_at: "2026-08-16T13:00:00Z" },
    { email: "three@lennar.com", created_at: "2026-01-01T12:00:00Z", used_at: null }
  ];
  eq(BP.pendingInvites(rows, now).map(r => r.email), ["one@lennar.com"],
     "pending = unused and unexpired");
});

group("health helpers", () => {
  eq(BP.assess(0, { warn: 1, bad: 5 }), "ok", "assess ok");
  eq(BP.assess(2, { warn: 1, bad: 5 }), "warn", "assess warn");
  eq(BP.assess(9, { warn: 1, bad: 5 }), "bad", "assess bad");
  eq(BP.rollUp([{ state: "ok" }, { state: "warn" }]), "warn", "rollUp warn");
  eq(BP.rollUp([{ state: "ok" }, { state: "bad" }, { state: "warn" }]), "bad", "rollUp bad wins");
  eq(BP.rollUp([]), "ok", "empty rolls up ok");
  eq(BP.daysSince("2026-08-10T12:00:00Z", "2026-08-17T12:00:00Z"), 7, "daysSince");
  eq(BP.relativeDay("2026-08-17T12:00:00Z", "2026-08-17T18:00:00Z"), "today", "relative today");
  eq(BP.relativeDay(null), "never", "relative never");
});

group("escaping", () => {
  eq(BP.escapeHtml('<img src=x onerror="alert(1)">'),
     "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;", "html escaped");
  eq(BP.escapeHtml(null), "", "null safe");
});

/* ------------------------------------------------------------------ report */

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
