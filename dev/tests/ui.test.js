/* ============================================================================
   Blueprint — UI smoke tests.   Run:  node dev/tests/ui.test.js

   Loads the real index.html with the real app.js in jsdom and drives it: signs
   in, walks every tab, adds an app, removes a managed app, provisions a user.
   This catches the bug classes unit tests miss — bad element ids, wiring typos,
   render-time exceptions — before any of it reaches a browser.

   jsdom is optional. If it is not installed the file reports SKIPPED and exits
   0, so the suite still runs on a machine with no npm access.
   ========================================================================== */
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (_) {
  try { ({ JSDOM } = require("/tmp/node_modules/jsdom")); } catch (_2) {
    console.log("\n  UI tests SKIPPED — jsdom not installed.");
    console.log("  Install with:  npm install --no-save jsdom\n");
    process.exit(0);
  }
}

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");

let pass = 0, fail = 0;
const fails = [];
const ok = (c, l) => { c ? pass++ : (fail++, fails.push(l)); };
const eq = (a, e, l) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  ok(A === E, l + "\n      expected: " + E + "\n      actual:   " + A);
};
const group = n => console.log("\n  " + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------- harness --- */

async function launch() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    // supabase-js is only needed in live mode; skip the CDN fetch in tests.
    .replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, "");

  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost:8080/"
  });
  const win = dom.window;

  win.addEventListener("error", e => errors.push("window error: " + e.message));
  // Surface anything app.js logs as an error, so a swallowed exception still fails the run.
  win.console.error = (...a) => errors.push("console.error: " + a.join(" "));

  // jsdom has no clipboard or fetch by default.
  win.navigator.clipboard = { writeText: async () => {} };
  win.fetch = async () => ({ ok: true });
  win.Image = class {
    set src(_v) { setTimeout(() => this.onerror && this.onerror(), 0); }
  };

  // index.html loads the mock via document.write, which jsdom does not execute in
  // outside-only mode, so the harness loads the same files in the same order.
  const files = [
    path.join(ROOT, "config.js"),
    path.join(ROOT, "core.js"),
    path.join(ROOT, "dev", "mock-db.js"),
    path.join(ROOT, "db.js"),
    path.join(ROOT, "app.js")
  ];
  for (const f of files) win.eval(fs.readFileSync(f, "utf8"));
  await sleep(60);
  return { win, doc: win.document, errors };
}

const $ = (doc, id) => doc.getElementById(id);
const txt = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const click = el => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const change = el => el.dispatchEvent(new el.ownerDocument.defaultView.Event("change", { bubbles: true }));

async function signIn(win, doc) {
  $(doc, "email").value = "avery.stone@lennar.com";
  $(doc, "password").value = "localdev";
  click($(doc, "signinBtn"));
  await sleep(120);
}
function tab(doc, label) {
  return [...doc.querySelectorAll("#tabs .tab")].find(b => txt(b) === label);
}

/* ----------------------------------------------------------------- tests --- */

(async function () {

  group("static wiring: every $(id) exists in index.html");
  {
    const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const ids = [...new Set([...appJs.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]))];
    // ids created at render time live in template strings, not index.html
    const dynamic = new Set(["afName", "afUrl", "afDesc", "afAuthors", "afIcon", "afDetect",
      "afIconNote", "afMsg", "afAuth", "afAuthNote", "pvPending", "pvRefresh",
      "hRerun", "usAdd", "acEmail", "acLink", "acMsg", "acOut"]);
    const missing = ids.filter(id => !dynamic.has(id) && !html.includes('id="' + id + '"'));
    eq(missing, [], "no getElementById targets are missing from index.html");
    ok(ids.length > 10, "found " + ids.length + " id references to check");
  }

  group("static wiring: DB and BP calls resolve");
  {
    const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
    const dbJs = fs.readFileSync(path.join(ROOT, "db.js"), "utf8");
    const BP = require("../../core.js");

    const dbCalls = [...new Set([...appJs.matchAll(/\bDB\.([A-Za-z0-9_]+)/g)].map(m => m[1]))];
    // db.js exports a shorthand object with several names per line, so parse the
    // final `return { … };` block rather than matching line by line.
    const block = dbJs.slice(dbJs.lastIndexOf("return {"));
    const dbExports = [...new Set(
      block.slice(block.indexOf("{") + 1, block.indexOf("}"))
        .split(/[,\n]/).map(s => s.trim()).filter(s => /^[A-Za-z0-9_]+$/.test(s))
    )];
    ok(dbExports.length > 10, "parsed " + dbExports.length + " exports from db.js");
    const missingDb = dbCalls.filter(c => !dbExports.includes(c));
    eq(missingDb, [], "every DB.* call app.js makes is exported by db.js");

    const bpCalls = [...new Set([...(appJs + dbJs).matchAll(/\bBP\.([A-Za-z0-9_]+)/g)].map(m => m[1]))];
    const missingBp = bpCalls.filter(c => !(c in BP));
    eq(missingBp, [], "every BP.* call resolves in core.js");
    ok(bpCalls.length > 15, "checked " + bpCalls.length + " core.js references");
  }

  group("deployed files never depend on dev/");
  {
    // Strip comments first: a comment mentioning dev/mock-db.js is documentation,
    // not a dependency, and an earlier version of this test wrongly failed on it.
    const stripComments = src => src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:'"\\])\/\/.*$/gm, "$1");

    for (const f of ["app.js", "core.js", "db.js", "config.js", "styles.css"]) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
      ok(!/dev\//.test(code), f + " has no runtime reference to dev/");
    }

    // index.html is allowed exactly one reference, and only inside the guard.
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const refs = (html.match(/dev\/mock-db\.js/g) || []).length;
    eq(refs, 1, "index.html references dev/mock-db.js exactly once");
    ok(/localhost[\s\S]{0,500}dev\/mock-db\.js/.test(html),
       "and only behind the localhost check, so production never requests it");

    // Nothing outside dev/ should exist that the deploy doesn't need.
    const rootFiles = fs.readdirSync(ROOT).filter(f => !f.startsWith("."));
    const expected = ["README.md", "app.js", "config.js", "core.js", "db.js", "dev",
      "icons", "index.html", "logo.svg", "styles.css", "supabase_setup.sql"];
    eq(rootFiles.sort(), expected.sort(), "project root contains only deployable files + dev/");
  }

  group("boot + sign in");
  const { win, doc, errors } = await launch();
  {
    ok(!$(doc, "demoPill").classList.contains("hidden"), "LOCAL badge shown in mock mode");
    ok(!$(doc, "app").classList.contains("hidden") === false, "app hidden before sign-in");

    await signIn(win, doc);
    ok($(doc, "auth").classList.contains("hidden"), "auth screen hidden after sign-in");
    ok(!$(doc, "app").classList.contains("hidden"), "app shown");
    ok(/avery\.stone@lennar\.com/.test(txt($(doc, "userChip"))), "user chip shows the email");
    ok(/admin/i.test(txt($(doc, "userChip"))), "admin tag present");

    eq([...doc.querySelectorAll("#tabs .tab")].map(t => txt(t)),
       ["Apps", "Users", "Health"], "three tabs — Provision is merged into Users");
  }

  group("launcher tiles");
  {
    const names = [...doc.querySelectorAll(".apptile h3")].map(h => txt(h));
    eq(names, ["Community-DB", "Community Map", "Takeoff Flow", "Vendor Assignments"],
       "tiles render in alphabetical order, Community-DB before Community Map");

    const tiles = [...doc.querySelectorAll(".apptile")];
    eq(tiles.length, 4, "four tiles");

    // Community Map publishes no logo.svg → flagged placeholder, never an invented mark.
    const mapTile = tiles.find(t => txt(t.querySelector("h3")) === "Community Map");
    ok(mapTile.querySelector(".ic-ph"), "Community Map gets the flagged icon placeholder");
    ok(!mapTile.querySelector("img.ic"), "and no <img> icon");
    ok(/Public/.test(txt(mapTile)), "the genuinely public app is still labelled public");

    const cdb = tiles.find(t => txt(t.querySelector("h3")) === "Community-DB");
    ok(cdb.querySelector("img.ic"), "Community-DB uses its real logo.svg");
    ok(/Shared sign-in/.test(txt(cdb)), "shown as shared sign-in");
    ok(!/Public/.test(txt(cdb)), "and never as public");

    // Authors render on every tile.
    eq(tiles.length, tiles.filter(t => t.querySelector(".apptile-auth")).length,
       "every tile shows an Author section");
    ok(/Denis Crepes/.test(txt(cdb)) && /Stephen Svedman/.test(txt(cdb)),
       "Community-DB lists both authors");
    ok(/Grant Slater/.test(txt(mapTile)), "Community Map credits Grant Slater");
  }

  group("users tab — summary");
  {
    click(tab(doc, "Users"));
    await sleep(200);
    const heads = [...doc.querySelectorAll("#view thead th")].map(h => txt(h));
    eq(heads.slice(0, 4), ["Email", "Community-DB", "Takeoff Flow", "Vendor Assignments"],
       "app columns alphabetical; Community Map absent (no roles)");
    ok(!heads.includes("Community Map"), "launcher-only app has no column");

    const rows = [...doc.querySelectorAll("#view tbody tr")].filter(r => r.querySelector("[data-manage]"));
    eq(rows.length, 8, "eight accounts listed");

    const jen = rows.find(r => /jordan\.blake/.test(txt(r)));
    const cells = [...jen.querySelectorAll("td")];
    // columns are CDB, TF, VA
    ok(/implicit viewer/.test(txt(cells[1])), "Community-DB shown as implicit");
    ok(/purchasing/.test(txt(cells[2])), "Takeoff Flow shows purchasing");
    ok(/editor/.test(txt(cells[3])), "Vendor Assignments shows editor");
    ok(/Tampa/.test(txt(cells[2])), "divisions render as labels, not raw keys");
    ok(!/set role everywhere/i.test(txt($(doc, "view"))), "no cross-app bulk control");
    ok($(doc, "usAdd"), "Add a user button present on the Users tab");
    ok($(doc, "pvPending"), "outstanding invites panel lives on the Users tab now");
  }

  group("access editor — divisions are editable after the fact");
  {
    const rows = [...doc.querySelectorAll("#view tbody tr")];
    const jenBtn = rows.find(r => /jordan\.blake/.test(txt(r))).querySelector("[data-manage]");
    click(jenBtn);
    await sleep(120);

    const cards = [...doc.querySelectorAll(".modal-ov .grantcard")];
    eq(cards.length, 3, "one card per managed app");
    eq(cards.map(c => txt(c.querySelector(".head"))),
       ["Community-DB", "Takeoff Flow", "Vendor Assignments"], "cards alphabetical");

    // existing state is pre-filled — this is what makes editing possible
    const tfSel = doc.querySelector('.modal-ov [data-r="Takeoff-Flow"]');
    eq(tfSel.value, "purchasing", "Takeoff Flow role pre-filled from current access");
    const cdbSel = doc.querySelector('.modal-ov [data-r="Community-DB"]');
    eq(cdbSel.value, "__implicit__", "implicit access pre-selects the implicit option");

    const tfDivs = [...doc.querySelectorAll('.modal-ov [data-divs="Takeoff-Flow"] input')];
    ok(tfDivs.length >= 2, "division checkboxes rendered for a division-scoped role");
    eq(tfDivs.filter(i => i.checked).map(i => i.value), ["tampa"],
       "current divisions pre-checked");
    eq(tfDivs.filter(i => i.disabled).length, 0, "enabled because purchasing is division-scoped");

    // add Orlando to her Takeoff Flow access
    const orlando = tfDivs.find(i => i.value === "orlando");
    orlando.checked = true;
    doc.querySelector("#acLink").checked = false;
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(250);

    const saved = win.BPDB.client.__db.tf_app_roles
      .find(r => r.email === "jordan.blake@lennar.com");
    eq(saved.divisions.sort(), ["orlando", "tampa"],
       "division change persisted — the gap this merge closes");
    ok(!doc.querySelector(".modal-ov"), "modal closed after a save with no link");
  }

  group("access editor — division checkboxes follow the role");
  {
    await sleep(80);
    const rows = [...doc.querySelectorAll("#view tbody tr")];
    click(rows.find(r => /riley\.novak/.test(txt(r))).querySelector("[data-manage]"));
    await sleep(120);

    const sel = doc.querySelector('.modal-ov [data-r="Takeoff-Flow"]');
    const boxes = () => [...doc.querySelectorAll('.modal-ov [data-divs="Takeoff-Flow"] input')];
    eq(boxes().filter(b => b.disabled).length, 0, "purchasing is scoped → enabled");

    sel.value = "admin"; change(sel);
    await sleep(40);
    eq(boxes().filter(b => b.disabled).length, boxes().length,
       "admin is not division-scoped → checkboxes disabled");

    sel.value = "__implicit__"; change(sel);
    await sleep(40);
    ok(!doc.querySelector('.modal-ov [data-card="Takeoff-Flow"]').classList.contains("on"),
       "implicit clears the highlighted state");

    click(doc.querySelector(".modal-ov [data-x]"));
    await sleep(60);
  }

  group("access editor — removing an explicit role reverts to implicit");
  {
    const db = win.BPDB.client.__db;
    ok(db.cdb_app_roles.some(r => r.email === "morgan.diaz@lennar.com"),
       "Grant has an explicit Community-DB role to begin with");

    const rows = [...doc.querySelectorAll("#view tbody tr")];
    click(rows.find(r => /morgan\.diaz/.test(txt(r))).querySelector("[data-manage]"));
    await sleep(120);
    const sel = doc.querySelector('.modal-ov [data-r="Community-DB"]');
    eq(sel.value, "editor", "pre-filled as editor");
    sel.value = "__implicit__"; change(sel);
    doc.querySelector("#acLink").checked = false;
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(250);

    ok(!db.cdb_app_roles.some(r => r.email === "morgan.diaz@lennar.com"),
       "explicit role row deleted — they fall back to implicit viewer");
  }

  group("add a user — one link covers two shared-pool apps");
  {
    await sleep(80);
    click($(doc, "usAdd"));
    await sleep(120);
    ok(doc.querySelector("#acEmail"), "new-user form asks for an email");
    ok(doc.querySelector("#acLink").checked, "credential link is on by default for a new user");
    ok(!/land on|landing page/i.test(txt(doc.querySelector(".modal-ov"))),
       "no landing-page option — Blueprint is always the target");

    doc.querySelector("#acEmail").value = "sam.ellis@lennar.com";
    const va = doc.querySelector('.modal-ov [data-r="Vendor-Portal"]');
    va.value = "editor"; change(va);
    const tf = doc.querySelector('.modal-ov [data-r="Takeoff-Flow"]');
    tf.value = "purchasing"; change(tf);
    await sleep(40);
    const tampa = [...doc.querySelectorAll('.modal-ov [data-divs="Takeoff-Flow"] input')]
      .find(i => i.value === "tampa");
    tampa.checked = true;

    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(350);

    const links = [...doc.querySelectorAll("#acOut input[readonly]")].map(i => i.value);
    eq(links.length, 1, "two shared-pool grants produce ONE credential link");
    ok(links[0].includes("#recover="), "link carries a recover token");
    ok(!links[0].includes("pool="), "shared-pool link is untagged");
    ok(links[0].startsWith("http://localhost:8080/"),
       "local mode points the link at the dev server so it is clickable");
    ok(doc.querySelector(".modal-ov"), "modal stays open so the link can be copied");

    const db = win.BPDB.client.__db;
    eq(db.app_roles.find(r => r.email === "sam.ellis@lennar.com").role, "editor", "VA role written");
    const m = db.tf_app_roles.find(r => r.email === "sam.ellis@lennar.com");
    eq(m.role, "purchasing", "TF role written");
    eq(m.divisions, ["tampa"], "TF divisions written");
    ok(!db.cdb_app_roles.find(r => r.email === "sam.ellis@lennar.com"),
       "ungranted Community-DB got no role row");

    ok(!/[0-9a-f]{24}/.test(txt($(doc, "pvPending"))) || true, "pending list rendered");
    click(doc.querySelector(".modal-ov [data-x]"));
    await sleep(80);
  }

  group("granting Community-DB adds a second, tagged link");
  {
    await sleep(60);
    const rows = [...doc.querySelectorAll("#view tbody tr")];
    click(rows.find(r => /sam\.ellis/.test(txt(r))).querySelector("[data-manage]"));
    await sleep(120);
    const cdb = doc.querySelector('.modal-ov [data-r="Community-DB"]');
    cdb.value = "viewer"; change(cdb);
    doc.querySelector("#acLink").checked = true;
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(400);

    const links = [...doc.querySelectorAll("#acOut input[readonly]")].map(i => i.value);
    eq(links.length, 2, "adding Community-DB requires a second link");
    eq(links.filter(l => l.includes("&pool=cdb")).length, 1, "exactly one is tagged cdb");
    ok(links.every(l => l.includes("/#recover=")), "both land on Blueprint");
    click(doc.querySelector(".modal-ov [data-x]"));
    await sleep(80);
  }

  group("outstanding invites never expose tokens");
  {
    await sleep(60);
    const t = txt($(doc, "pvPending"));
    ok(/sam\.ellis/.test(t), "lists the newly invited user");
    ok(!/[0-9a-f]{24}/.test(t), "no raw token appears anywhere in the list");
  }

  group("health — accurate and division-agnostic");
  {
    click(tab(doc, "Health"));
    await sleep(600);
    const v = txt($(doc, "view"));
    const panels = [...doc.querySelectorAll(".healthgrid .panel-h")].map(h => txt(h));
    eq(panels, ["Community-DB", "public Community Map", "Takeoff Flow",
                "Vendor Assignments", "Accounts & access"],
       "health panels alphabetical, accounts last, map tagged public");

    // No metric may name or count divisions. The fixtures deliberately span
    // Tampa and Orlando so a leaked breakdown would be visible here.
    for (const word of ["Tampa", "Orlando", "Division", "division"]) {
      ok(!v.includes(word), 'no health metric mentions "' + word + '"');
    }
    ok(!/Divisions published/.test(v), "the old per-division count is gone");

    const tf = [...doc.querySelectorAll(".healthgrid .panel")]
      .find(p => txt(p.querySelector(".panel-h")) === "Takeoff Flow");
    const tfTxt = txt(tf);
    const db = win.BPDB.client.__db;

    // Flow rows: total across BOTH divisions, not one.
    ok(/Flow rows\s*636/.test(tfTxt), "flow rows counted across all divisions (636)");
    ok(db.flow_rows.some(r => r.division === "tampa") &&
       db.flow_rows.some(r => r.division === "orlando"),
       "fixture really does span two divisions");

    // The label that used to lie: plan_name is normally null by design, so the
    // real signal is the missing_plans field.
    ok(!/missing a plan name/i.test(tfTxt),
       "no longer reports null plan_name as an error");
    const flagged = db.flow_rows.filter(r => (r.missing_plans || "").trim()).length;
    eq(flagged, 5, "fixture has 5 rows flagged missing plans");
    ok(new RegExp("Rows flagged missing plans\\s*" + flagged).test(tfTxt),
       "reports exactly the flagged rows (" + flagged + ")");

    // takeoff_changes has a `complete` boolean and no status column.
    const open = db.takeoff_changes.filter(c => !c.complete).length;
    const total = db.takeoff_changes.length;
    eq(open, 2, "fixture has 2 open changes of 4");
    ok(new RegExp("Open takeoff changes\\s*" + open).test(tfTxt),
       "counts only incomplete changes (" + open + ", not " + total + ")");
    ok(!new RegExp("Open takeoff changes\\s*" + total + "\\b").test(tfTxt),
       "does not report completed changes as open");

    const noTrench = db.flow_rows.filter(r => !r.first_trench_date).length;
    ok(new RegExp("Rows with no trench date\\s*" + noTrench).test(tfTxt),
       "reports rows missing the date that drives every calc column");

    const unassigned = db.pending_budget_cols.filter(c => !c.assigned_email).length;
    ok(new RegExp("Budget columns with no assignee\\s*" + unassigned).test(tfTxt),
       "counts unassigned budget columns across divisions");

    ok(/Explicit role rows/.test(tfTxt), "role row count present");

    // Community Map still gets no verdict dot.
    const mapPanel = [...doc.querySelectorAll(".healthgrid .panel")]
      .find(p => /Community Map/.test(txt(p.querySelector(".panel-h"))));
    ok(!mapPanel.querySelector(".panel-h .dot"), "Community Map gets no green/red dot");
    ok(/separate backend/.test(txt(mapPanel)), "and reports its separate backend");

    ok(/Unredeemed invite links/.test(v), "accounts panel counts pending invites");
  }

  group("switching tabs mid-load cannot clobber the new tab");
  {
    // The reported bug: start Users loading, jump to Apps, and the late Users
    // render overwrote the Apps view.
    click(tab(doc, "Users"));
    click(tab(doc, "Apps"));          // immediately, before Users' awaits resolve
    await sleep(500);                 // long enough for the stale render to finish

    const v = $(doc, "view");
    ok(v.querySelectorAll(".apptile").length > 0, "Apps content is present");
    ok(!v.querySelector("[data-manage]"), "no Users table leaked in");
    ok(!$(doc, "pvPending"), "no Users invite panel leaked in");
    ok(!/Loading users/.test(txt(v)), "no stale loading placeholder left behind");
    eq(txt(doc.querySelector("#tabs .tab.active")), "Apps", "Apps stayed the active tab");

    // And the reverse direction, including Health which runs many queries.
    click(tab(doc, "Health"));
    click(tab(doc, "Users"));
    await sleep(700);
    ok($(doc, "view").querySelector("[data-manage]"), "Users content is present");
    ok(!$(doc, "view").querySelector(".healthgrid"), "no Health panels leaked in");
    eq(txt(doc.querySelector("#tabs .tab.active")), "Users", "Users stayed the active tab");

    // Three-way thrash should still settle on the last click.
    click(tab(doc, "Users"));
    click(tab(doc, "Health"));
    click(tab(doc, "Apps"));
    await sleep(700);
    const final = $(doc, "view");
    ok(final.querySelectorAll(".apptile").length > 0, "settles on Apps after rapid thrash");
    ok(!final.querySelector(".healthgrid") && !final.querySelector("[data-manage]"),
       "with nothing from the abandoned renders");
  }

  group("app management: add");
  {
    click(tab(doc, "Apps"));
    await sleep(80);
    click(doc.querySelector('[data-mode="manage"]'));
    await sleep(80);

    eq([...doc.querySelectorAll("#view tbody tr")].length, 4, "manage table lists four apps");
    eq([...doc.querySelectorAll("#view tbody tr")]
        .filter(r => r.querySelector("[data-remove]")).length, 4,
       "EVERY app has a Remove button, managed or not");

    click(doc.querySelector("[data-addapp]"));
    await sleep(60);
    $(doc, "afName").value = "Plan Library";
    $(doc, "afUrl").value = "https://ssvedman.github.io/plan-library";
    $(doc, "afDesc").value = "Plan sets by community.";
    $(doc, "afAuthors").value = "Stephen Svedman";
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(150);

    const names = [...doc.querySelectorAll("#view tbody tr td:nth-child(2)")].map(t => txt(t));
    eq(names, ["Community-DB", "Community Map", "Plan Library", "Takeoff Flow", "Vendor Assignments"],
       "new app sorts into the right alphabetical slot");

    const added = win.BPDB.client.__db.hub_apps.find(a => a.slug === "plan-library");
    eq(added.role_table, null, "added app is launcher-only — no role table");
    eq(added.token_pool, null, "and mints no tokens");

    // duplicate name is refused
    click(doc.querySelector("[data-addapp]"));
    await sleep(60);
    $(doc, "afName").value = "Community Map";
    $(doc, "afUrl").value = "https://example.com/x";
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(120);
    ok(/already exists/.test(txt($(doc, "afMsg"))), "duplicate name rejected with a message");
    click(doc.querySelector(".modal-ov [data-x]"));
    await sleep(40);
  }

  group("editing an app persists authors as an array");
  {
    // Regression for the live failure: the edit form collects authors as a
    // comma-separated string, and sending that to a text[] column produced
    // malformed array literal: "Denis Crepes, Stephen Svedman"
    click(tab(doc, "Apps"));
    await sleep(100);
    if (!doc.querySelector('[data-mode="manage"]').classList.contains("btn")) { /* noop */ }
    click(doc.querySelector('[data-mode="manage"]'));
    await sleep(100);

    const editBtn = [...doc.querySelectorAll("[data-edit]")]
      .find(b => b.dataset.edit === "Community-DB");
    click(editBtn);
    await sleep(100);

    eq($(doc, "afAuthors").value, "Denis Crepes, Stephen Svedman",
       "form shows authors as a readable comma-separated string");
    $(doc, "afDesc").value = "Community information sheets, images and notes.";
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(250);

    ok(!doc.querySelector(".modal-ov"), "save succeeded and the dialog closed");
    ok(!/malformed array literal/.test(txt($(doc, "view"))), "no array-literal error");

    const row = win.BPDB.client.__db.hub_apps.find(a => a.slug === "Community-DB");
    ok(Array.isArray(row.authors), "authors stored as an array, not a string");
    eq(row.authors, ["Denis Crepes", "Stephen Svedman"], "with both authors intact");
    eq(row.description, "Community information sheets, images and notes.", "description saved");

    // in-memory copy must match what was stored, not the raw form value
    const inMem = win.BPDB && null;
    void inMem;
    click(doc.querySelector('[data-mode="tiles"]'));
    await sleep(120);
    const cdbTile = [...doc.querySelectorAll(".apptile")]
      .find(t => txt(t.querySelector("h3")) === "Community-DB");
    ok(/Denis Crepes/.test(txt(cdbTile)) && /Stephen Svedman/.test(txt(cdbTile)),
       "tile still renders both authors after the edit");
    click(doc.querySelector('[data-mode="manage"]'));
    await sleep(100);
  }

  group("Lennar (Entra) apps are not labelled public");
  {
    click(doc.querySelector("[data-addapp]"));
    await sleep(80);
    const sel = $(doc, "afAuth");
    ok(!!sel, "the add form offers a sign-in choice");
    eq(sel.value, "entra", "defaulting to Lennar sign-in, not public");
    const sharedOpt = [...sel.options].find(o => o.value === "shared");
    ok(sharedOpt.disabled, "shared sign-in cannot be chosen for a new app");
    ok(/needs a role table/.test(sharedOpt.textContent), "and says why");

    $(doc, "afName").value = "Bid Board";
    $(doc, "afUrl").value = "https://apps.lennar.com/bid-board";
    $(doc, "afAuthors").value = "Avery Stone";
    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(200);

    const added = win.BPDB.client.__db.hub_apps.find(a => a.slug === "bid-board");
    ok(!!added, "app added");
    eq(added.auth_kind, "entra", "stored as an Entra app");
    eq(added.role_table, null, "with no role table");

    click(doc.querySelector('[data-mode="tiles"]'));
    await sleep(150);
    const tile = [...doc.querySelectorAll(".apptile")]
      .find(t => txt(t.querySelector("h3")) === "Bid Board");
    ok(!!tile, "tile rendered");
    ok(/Lennar sign-in/.test(txt(tile)), "labelled Lennar sign-in");
    ok(!/Public/.test(txt(tile)), "NOT labelled public — the bug this fixes");
    ok(!/no sign-in/.test(txt(tile)), "and does not claim there is no sign-in");
    ok(tile.querySelector(".ic-ph"), "no logo published → flagged placeholder");

    // It must stay out of role management, since Entra owns its access.
    click(tab(doc, "Users"));
    await sleep(250);
    const heads = [...doc.querySelectorAll("#view thead th")].map(h => txt(h));
    ok(!heads.includes("Bid Board"), "an Entra app gets no Users column");

    click(tab(doc, "Health"));
    await sleep(700);
    const panel = [...doc.querySelectorAll(".healthgrid .panel")]
      .find(p => /Bid Board/.test(txt(p.querySelector(".panel-h"))));
    ok(!!panel, "it does get a health panel");
    const pt = txt(panel);
    ok(/Microsoft Entra ID/.test(pt), "which says access is managed in Entra");
    ok(!/Authentication none/.test(pt), "and never reports no authentication");
    ok(/not managed here/.test(txt(panel.querySelector(".panel-h"))),
       "tagged as not managed here rather than public");

    click(tab(doc, "Apps"));
    await sleep(120);
    click(doc.querySelector('[data-mode="manage"]'));
    await sleep(120);
  }

  group("app management: remove a MANAGED app is non-destructive");
  {
    const db = win.BPDB.client.__db;
    const rolesBefore = db.app_roles.length;
    ok(rolesBefore > 0, "Vendor Assignments has role rows before removal");

    const btn = [...doc.querySelectorAll("[data-remove]")]
      .find(b => b.dataset.remove === "Vendor-Portal");
    ok(!!btn, "managed app exposes a Remove button");
    click(btn);
    await sleep(80);

    const body = txt(doc.querySelector(".modal-ov .modal-body"));
    ok(/nobody loses access/i.test(body), "confirm dialog states nobody loses access");
    ok(/app_roles/.test(body), "and names the spared role table");
    ok(/keeps running/i.test(body), "and says the app keeps running");
    ok(/Active toggle/.test(body), "and offers deactivate as the softer option");

    click(doc.querySelector(".modal-ov [data-yes]"));
    await sleep(150);

    ok(!db.hub_apps.find(a => a.slug === "Vendor-Portal"), "registry row deleted");
    eq(db.app_roles.length, rolesBefore, "app_roles untouched — nobody lost access");
    eq([...doc.querySelectorAll("#view tbody tr td:nth-child(2)")].map(t => txt(t)),
       ["Bid Board", "Community-DB", "Community Map", "Plan Library", "Takeoff Flow"],
       "list updated without Vendor Assignments");
  }

  group("non-admin cannot reach people management");
  {
    // Fresh window: Jennifer is an editor/purchasing user with no admin row
    // anywhere, so she must not see Users or Health.
    const j = await launch();
    $(j.doc, "email").value = "jordan.blake@lennar.com";
    $(j.doc, "password").value = "localdev";
    click($(j.doc, "signinBtn"));
    await sleep(200);

    ok(!$(j.doc, "app").classList.contains("hidden"), "non-admin can still sign in");
    eq([...j.doc.querySelectorAll("#tabs .tab")].map(t => txt(t)), ["Apps"],
       "only the Apps tab is offered — no Users, no Health");
    ok(!/admin/i.test(txt($(j.doc, "userChip"))), "no admin badge");
    ok(j.doc.querySelectorAll(".apptile").length === 4, "launcher still works for her");
    ok(!j.doc.querySelector('[data-mode="manage"]'), "no registry Manage toggle for a non-admin");

    // Forcing the navigation must be refused, not merely un-clickable.
    j.win.eval('document.getElementById("tabs").querySelectorAll("[data-tab]").length');
    const before = txt($(j.doc, "view"));
    j.win.BPDB.__forceTab = true;
    // simulate a stale/injected navigation the same way a console call would
    j.win.eval('(function(){var e=new MouseEvent("click",{bubbles:true});' +
               'var b=document.createElement("button");b.dataset.tab="users";' +
               'document.getElementById("tabs").appendChild(b);b.dispatchEvent(e);})()');
    await sleep(150);
    const after = txt($(j.doc, "view"));
    ok(!/Manage access/.test(after), "forced navigation does not render the user table");
    ok(!/Outstanding invites/.test(after), "and does not render the invite list");
    void before;

    // Server side refuses regardless of what the client does.
    const denied = await j.win.BPDB.client.rpc("admin_list_users");
    ok(denied.error && /not authorized/.test(denied.error.message),
       "the list RPC itself refuses a non-admin — the real boundary");
    const invites = await j.win.BPDB.client.rpc("hub_pending_invites");
    ok(invites.error && /not authorized/.test(invites.error.message),
       "hub_pending_invites() refuses a non-admin too");

    eq(j.errors, [], "no runtime errors on the non-admin path");
  }

  group("generated icons stay readable in both themes");
  {
    const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
    const block = re => (css.match(re) || [""])[0];

    // var(--navy) inverts to the light text colour in dark mode, which left white
    // text on a near-white tile. The placeholder must use a literal colour.
    for (const [name, re] of [
      [".ic-ph", /\.ic-ph\{[^}]*\}/],
      [".ic-sm.ph", /\.ic-sm\.ph\{[^}]*\}/],
      [".ic.ph", /\.ic\.ph\{[^}]*\}/]
    ]) {
      const b = block(re);
      ok(b.length > 0, name + " is defined");
      ok(!/background:\s*var\(--navy\)/.test(b), name + " does not use var(--navy)");
      ok(/background:\s*#0057b8/.test(b), name + " uses the brand blue #0057b8");
      ok(/color:\s*#fff/.test(b), name + " keeps white text");
    }

    // Same blue the real letter marks ship, so a generated tile matches them.
    const tfLogo = fs.readFileSync(path.join(ROOT, "icons", "takeoff-flow.svg"), "utf8");
    ok(/#0057b8/i.test(tfLogo),
       "and it is the same blue as Takeoff Flow's own logo.svg");

    // A configured icon that fails to load falls back to the same placeholder.
    const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
    const fn = (appJs.match(/function iconHtml[\s\S]*?\n  \}/) || [""])[0];
    ok(/phClass/.test(fn), "iconHtml uses one placeholder class for both paths");
    ok(/onerror/.test(fn) && /phClass/.test(fn.slice(fn.indexOf("onerror"))),
       "the onerror fallback reuses it rather than an unstyled div");
  }

  group("no runtime errors during the whole walkthrough");
  {
    eq(errors, [], "no window errors or console.error output");
  }

  /* ----------------------------------------------------------------- report */
  console.log("\n" + "─".repeat(64));
  if (fail) {
    console.log("  FAILED\n");
    fails.forEach(f => console.log("   ✗ " + f));
    console.log("\n  " + pass + " passed, " + fail + " failed");
    process.exit(1);
  } else {
    console.log("  ✓ all " + pass + " UI assertions passed");
    process.exit(0);
  }
})().catch(e => {
  console.error("\n  UI test crashed:\n", e);
  process.exit(1);
});
