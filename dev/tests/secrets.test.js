/* ============================================================================
   Blueprint — repository hygiene scan.   Run:  node dev/tests/secrets.test.js

   This repo is public, so the risk is not only "did a secret leak" but also
   "did we publish internal detail nobody outside needs". This suite fails the
   build on either.

   What it enforces:
     1. No service_role key, and no JWT whose role claim is anything but anon.
     2. No real colleague names or addresses — fixtures must stay fictional.
     3. No stray credential tokens, passwords or .env content.
     4. Deployed files stay free of runtime dev/ dependencies.

   The Supabase anon key IS expected to be present. It is designed to be public
   and is already committed in the three sibling repos; row-level security is the
   boundary, not key secrecy. A test asserting its absence would be cargo-cult.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");

let pass = 0, fail = 0;
const fails = [];
const ok = (c, l) => { c ? pass++ : (fail++, fails.push(l)); };
const group = n => console.log("\n  " + n);

/* ------------------------------------------------------------------ collect */

const SKIP_DIRS = new Set([".git", "node_modules", ".nyc_output", "coverage"]);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}
const files = walk(ROOT).filter(f => !/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(f));
const rel = f => path.relative(ROOT, f).replace(/\\/g, "/");
const SELF = rel(__filename);
const read = f => fs.readFileSync(f, "utf8");

/* ------------------------------------------------------------------- tests */

group("no privileged credentials");
{
  const hits = [];
  for (const f of files) {
    if (rel(f) === SELF) continue;              // this file names the patterns
    const src = read(f);
    // Only an actual assignment counts. supabase_setup.sql mentions service_role
    // in order to warn against committing one, and flagging that would train
    // everyone to ignore this scan.
    if (/service[_-]?role[_a-z]*\s*[:=]\s*["'`][A-Za-z0-9._-]{20,}/i.test(src)) {
      hits.push(rel(f) + " assigns a service_role key");
    }
    // Decode any JWT-shaped string and check its role claim.
    for (const m of src.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{20,})\./g)) {
      let claims = {};
      try {
        claims = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
      } catch (_) { continue; }
      if (claims.role && claims.role !== "anon") {
        hits.push(rel(f) + ' contains a JWT with role "' + claims.role + '"');
      }
    }
  }
  ok(hits.length === 0, "no privileged keys committed\n      " + hits.join("\n      "));

  // Positive control: confirm the scan actually decodes the anon key, so a pass
  // here means the check ran rather than silently matching nothing.
  const cfg = read(path.join(ROOT, "config.js"));
  const jwt = cfg.match(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\./);
  ok(!!jwt, "config.js contains a JWT to inspect");
  const claims = JSON.parse(Buffer.from(jwt[1], "base64").toString("utf8"));
  ok(claims.role === "anon", 'and its role claim is "anon" (public by design)');
  ok(!!claims.exp && claims.exp * 1000 > Date.now(), "and it has not expired");
}

group("fixtures contain no real people");
{
  // Anyone who actually works here. Author credits are exempt — attribution on a
  // tile is intentional and is the same information as a git commit author.
  const REAL_NAMES = [
    /stephen\.svedman/i, /denis\.crepes/i, /grant\.whitfield/i,
    /jennifer\.reyes/i, /erik\.donnelly/i, /sandy\.pham/i, /daysi\.olivera/i,
    /marcus\.hale/i
  ];

  // Scoped to fixtures and source, not documentation. Author credits on a tile
  // ("Stephen Svedman", "Grant Slater") are intentional attribution — the same
  // information a git log already publishes — so full names are not scanned.
  // What must never appear is a real person used as *test data*, which is how
  // role assignments and the email convention would leak.
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (r === SELF) continue;
    const isFixtureOrCode = /\.js$/.test(r);
    if (!isFixtureOrCode) continue;
    let src = read(f);
    // config.js may carry the maintainer's own address as FEEDBACK_EMAIL — that
    // is a published contact point, not fixture data. Exempt that single line and
    // keep scanning the rest of the file.
    if (r === "config.js") src = src.replace(/^.*FEEDBACK_EMAIL.*$/m, "");
    for (const re of REAL_NAMES) {
      if (re.test(src)) hits.push(r + " uses a real person as data: " + re);
    }
    // Real first names lifted from Takeoff Flow's live DEFAULT_BUDGET_COLUMNS.
    if (/"(Jennifer|Erik|Daysi|Sandy)"/.test(src)) {
      hits.push(r + " contains a real first name in a fixture");
    }
  }
  ok(hits.length === 0,
     "no real colleague addresses or fixture names\n      " + hits.join("\n      "));

  // Every @lennar.com address in the repo must be fictional.
  // Every address in the repo must be on this list, and every entry must be
  // fictional. Adding a real colleague here is the mistake this guards against.
  const allowed = new Set([
    // fictional fixture people
    "avery.stone@lennar.com", "jordan.blake@lennar.com", "casey.morgan@lennar.com",
    "riley.novak@lennar.com", "quinn.harper@lennar.com", "morgan.diaz@lennar.com",
    "taylor.reed@lennar.com", "sam.ellis@lennar.com",
    // fictional short forms used in unit tests
    "avery@lennar.com", "jordan@lennar.com", "casey@lennar.com", "morgan@lennar.com",
    "riley@lennar.com", "quinn@lennar.com",
    "one@lennar.com", "two@lennar.com", "three@lennar.com",
    // maintainer contact, published deliberately (config.js FEEDBACK_EMAIL only)
    "stephen.svedman@lennar.com",
    // generic placeholders in UI copy and docs
    "you@lennar.com", "name@lennar.com", "newhire@lennar.com",
    "nobody@lennar.com", "another@lennar.com", "new@lennar.com",
    "notanemail@gmail.com"
  ]);
  const found = new Set();
  for (const f of files) {
    if (rel(f) === SELF) continue;
    for (const m of read(f).matchAll(/[A-Za-z0-9._%+-]+@lennar\.com/g)) {
      // '%@lennar.com' is the domain LIKE pattern in SQL, not an address.
      if (m[0].startsWith("%")) continue;
      found.add(m[0].toLowerCase());
    }
  }
  const unknown = [...found].filter(e => !allowed.has(e));
  ok(unknown.length === 0,
     "every @lennar.com address is a known placeholder\n      unexpected: " + unknown.join(", "));
}

group("no stray secrets or tokens");
{
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (r === SELF || r === ".gitignore") continue;
    const src = read(f);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(src)) hits.push(r + ": private key");
    if (/\bpostgres(ql)?:\/\/[^\s"']*:[^\s"']+@/.test(src)) hits.push(r + ": database URL with password");
    if (/\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/.test(src)) hits.push(r + ": secret API key");
    if (/\bghp_[A-Za-z0-9]{20,}/.test(src)) hits.push(r + ": GitHub token");
    // A literal 24-hex credential token — the shape our invite tokens take.
    if (/["'][0-9a-f]{24,}["']/.test(src) && !/mock-db\.js$|\.test\.js$/.test(r)) {
      hits.push(r + ": hex string resembling a live credential token");
    }
  }
  ok(hits.length === 0, "no secrets found\n      " + hits.join("\n      "));

  ok(!files.some(f => /(^|\/)\.env/.test(rel(f))), "no .env file committed");
}

group("public README stays non-operational");
{
  // The README is the most-read file in a public repo, so it must not double as a
  // runbook. Deploy steps, RPC and table names, the token design and the
  // break-glass credential path all live in the internal operations doc outside
  // this repository. Each term below leaked one of those when it was in here.
  const readme = read(path.join(ROOT, "README.md"));
  const banned = [
    [/service_role/i,              "service_role key discussion"],
    [/anon key|SUPABASE_ANON_KEY/i, "anon key discussion"],
    [/admin_add_or_reset|redeem_reset_token|hub_pending_invites|admin_list_users/i,
                                    "RPC names"],
    [/password_reset_tokens|cdb_reset_tokens|app_roles|hub_apps/i, "table names"],
    [/#recover=|pool=cdb|token pool/i, "credential-link mechanics"],
    [/break.?glass/i,              "break-glass procedure"],
    [/git push|git remote|Settings → Pages|npm install/i, "deploy or setup steps"],
    [/SQL Editor|supabase_setup\.sql/i, "database setup steps"],
    [/localhost:\d+|\?live=1/i,     "local development instructions"],
    [/supabase\.co/i,              "project URL"],
    [/lennar/i,                    "the company name"]
  ];
  const hits = banned.filter(([re]) => re.test(readme)).map(([, what]) => what);
  ok(hits.length === 0,
     "README contains no operational detail\n      found: " + hits.join(", "));

  // It should still explain what the thing is.
  ok(/Blueprint/.test(readme) && readme.length > 400, "README still describes the tool");
  ok(readme.length < 4000, "README stays short — it is a description, not a manual");
}

group("footer contact link is wired");
{
  // Regression guard. FEEDBACK_EMAIL once shipped empty, and app.js removes the
  // link rather than rendering a dead one — so the button silently vanished in
  // production with nothing failing.
  const cfg = read(path.join(ROOT, "config.js"));
  const m = cfg.match(/FEEDBACK_EMAIL:\s*"([^"]*)"/);
  ok(!!m, "config.js defines FEEDBACK_EMAIL");
  ok(m[1].length > 0, "FEEDBACK_EMAIL is set, so the footer link renders");
  ok(/@/.test(m[1]), "and looks like an address");

  const html = read(path.join(ROOT, "index.html"));
  ok(/id="feedbackLink"/.test(html), "index.html has the link element to populate");
  ok(!/mailto:[^"]*@/.test(html), "and hardcodes no address in the markup");
}

group("deployed surface is minimal");
{
  const rootEntries = fs.readdirSync(ROOT).filter(n => !n.startsWith("."));
  const expected = ["README.md", "app.js", "config.js", "core.js", "db.js", "dev",
    "icons", "index.html", "logo.svg", "styles.css", "supabase_setup.sql"].sort();
  ok(JSON.stringify(rootEntries.sort()) === JSON.stringify(expected),
     "root holds only deployable files + dev/\n      got: " + rootEntries.join(", "));

  const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"\\])\/\/.*$/gm, "$1");
  for (const f of ["app.js", "core.js", "db.js", "config.js"]) {
    ok(!/dev\//.test(stripComments(read(path.join(ROOT, f)))),
       f + " has no runtime dev/ reference");
  }
}

/* ------------------------------------------------------------------ report */

console.log("\n" + "─".repeat(64));
if (fail) {
  console.log("  FAILED\n");
  fails.forEach(f => console.log("   ✗ " + f));
  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(1);
} else {
  console.log("  ✓ all " + pass + " hygiene checks passed");
  process.exit(0);
}
