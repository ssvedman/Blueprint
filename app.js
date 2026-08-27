/* ============================================================================
   Blueprint — app.js   (UI only; logic lives in core.js, data in db.js)

   Three tabs: Apps · Users · Health.
   Users and Provision are merged: a person's roles, divisions and credential
   links are one concern, edited in one place.
   Apps and Health are open to everyone; Users is admin-only. Health hides any
   metric RLS would silently truncate for the viewer rather than show a wrong
   number. Ordering is alphabetical everywhere, via core.js.
   ========================================================================== */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG, BP = window.BP, DB = window.BPDB;
  const $ = id => document.getElementById(id);
  const esc = BP.escapeHtml;

  const state = {
    email: null, apps: [], fallback: false, users: [], me: null,
    adminSlugs: [], isAdmin: false, tab: "apps", appsMode: "tiles",
    query: "", divisions: {}, health: null, userFailures: []
  };

  /* ------------------------------------------------------------------ chrome */

  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "show " + (kind || "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ""; }, 3200);
  }

  function authMsg(text, kind) {
    const m = $("authMsg");
    m.className = "msg " + (kind || "info");
    m.textContent = text || "";
    if (!text) m.className = "msg";
  }

  function modal(title, bodyHtml, onMount) {
    document.querySelectorAll(".modal-ov").forEach(m => m.remove());
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML =
      '<div class="modal-card"><div class="modal-h"><span>' + esc(title) +
      '</span><button class="linkbtn" data-x aria-label="Close">&times;</button></div>' +
      '<div class="modal-body">' + bodyHtml + "</div></div>";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("[data-x]").onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
    });
    if (onMount) onMount(ov, close);
    return { ov, close };
  }

  function confirmBox(title, bodyHtml, okText, danger) {
    return new Promise(resolve => {
      modal(title,
        bodyHtml +
        '<div class="modal-actions"><button class="btn ghost" data-no>Cancel</button>' +
        '<button class="btn' + (danger ? " danger" : "") + '" data-yes>' + esc(okText || "OK") + "</button></div>",
        (ov, close) => {
          ov.querySelector("[data-no]").onclick = () => { close(); resolve(false); };
          ov.querySelector("[data-yes]").onclick = () => { close(); resolve(true); };
        });
    });
  }

  /* Same as confirmBox, but the operator has to type the thing being destroyed
     before the button works. Reserved for deleting a login: unlike removing an
     app tile, there is no version of this that can be undone by re-entering a
     few fields, and the row it acts on is one click away from the row above it
     in a table of colleagues. */
  function confirmTyped(title, bodyHtml, phrase, okText) {
    return new Promise(resolve => {
      modal(title,
        bodyHtml +
        '<label class="fld" style="margin-top:14px">Type <b>' + esc(phrase) +
        "</b> to confirm</label>" +
        '<input type="text" data-phrase autocomplete="off" spellcheck="false">' +
        '<div class="modal-actions"><button class="btn ghost" data-no>Cancel</button>' +
        '<button class="btn danger" data-yes disabled>' + esc(okText || "OK") + "</button></div>",
        (ov, close) => {
          const input = ov.querySelector("[data-phrase]");
          const yes = ov.querySelector("[data-yes]");
          // Compared case-insensitively and trimmed: this is a confirmation of
          // intent, not a password, and an address pasted from Outlook arrives
          // with stray whitespace and sometimes different case.
          const check = () => {
            yes.disabled = input.value.trim().toLowerCase() !== (phrase || "").toLowerCase();
          };
          input.oninput = check;
          input.onkeydown = e => { if (e.key === "Enter" && !yes.disabled) yes.click(); };
          ov.querySelector("[data-no]").onclick = () => { close(); resolve(false); };
          yes.onclick = () => { if (yes.disabled) return; close(); resolve(true); };
          check();
          input.focus();
        });
    });
  }

  /* -------------------------------------------------------------------- auth */

  async function boot() {
    if (!DB.LIVE) {
      $("demoPill").classList.remove("hidden");
      $("authSub").textContent =
        "Local development mode — running on in-memory data. Any password of 4+ characters works.";
      $("email").value = CFG.DEV_USER || "";
      $("password").value = "localdev";
    } else if (DB.FORCED_LIVE_LOCALLY) {
      // Real credentials from a dev server. Every write here is production, so
      // say so unmistakably rather than letting it look like the mock.
      const pill = $("demoPill");
      pill.textContent = "LIVE DATA";
      pill.style.background = "var(--bad)";
      pill.classList.remove("hidden");
      $("authSub").textContent =
        "Running against the real Supabase project from localhost. Changes here affect production.";
    }

    const rec = BP.parseRecoverHash(location.hash);
    if (rec) return showRecover(rec);

    const existing = await DB.currentEmail();
    if (existing) return enter(existing);

    $("signinBtn").onclick = doSignIn;
    $("password").onkeydown = e => { if (e.key === "Enter") doSignIn(); };
    $("email").onkeydown = e => { if (e.key === "Enter") $("password").focus(); };
  }

  async function doSignIn() {
    authMsg("");
    const btn = $("signinBtn");
    btn.disabled = true; btn.textContent = "Signing in…";
    const r = await DB.signIn($("email").value, $("password").value);
    btn.disabled = false; btn.textContent = "Sign in";
    if (!r.ok) return authMsg(r.error, "err");
    enter(r.email);
  }

  // Blueprint is the landing page for every credential link in the suite, so
  // this screen has to work for both token pools.
  function showRecover(rec) {
    $("stepSignin").classList.add("hidden");
    $("stepRecover").classList.remove("hidden");
    $("authSub").textContent = "Choose a password. It will sign you in to every tool you have access to.";
    $("setPassBtn").onclick = async () => {
      authMsg("");
      const p1 = $("newPass").value, p2 = $("newPass2").value;
      if (p1.length < 8) return authMsg("Password must be at least 8 characters.", "err");
      if (p1 !== p2) return authMsg("Those passwords don't match.", "err");
      const btn = $("setPassBtn");
      btn.disabled = true; btn.textContent = "Setting…";
      const r = await DB.redeem(rec.token, rec.pool, p1);
      btn.disabled = false; btn.textContent = "Set password";
      if (!r.ok) return authMsg(r.error, "err");
      authMsg("Password set. Signing you in…", "ok");
      history.replaceState(null, "", location.pathname);
      setTimeout(() => location.reload(), 1200);
    };
  }

  async function enter(email) {
    state.email = email;
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");

    const loaded = await DB.loadApps();
    state.apps = loaded.apps;
    state.fallback = loaded.fallback;

    // Admin status is derived from the same role tables the apps use — Blueprint
    // grants itself nothing.
    const managed = BP.managedApps(state.apps);
    state.adminSlugs = [];
    for (const app of managed) {
      const { data } = await DB.client.from(app.role_table).select().eq("email", email).maybeSingle();
      if (data && data.role === "admin") state.adminSlugs.push(app.slug);
    }
    state.isAdmin = state.adminSlugs.length > 0;

    $("userChip").innerHTML = esc(email) +
      (state.isAdmin ? '<span class="role-tag">admin</span>' : "");
    $("logoutBtn").onclick = async () => { await DB.signOut(); location.reload(); };
    $("homeLogo").onclick = () => go("apps");

    const fb = $("feedbackLink");
    if (CFG.FEEDBACK_EMAIL) {
      fb.href = "mailto:" + CFG.FEEDBACK_EMAIL + "?subject=Blueprint%20feedback";
    } else {
      fb.remove();   // no address configured — don't render a dead link
    }
    $("themeBtn").onclick = toggleTheme;
    $("globalSearch").oninput = e => {
      state.query = e.target.value;
      if (state.tab === "users" || state.tab === "apps") render();
    };
    initTheme();

    if (state.fallback) {
      toast("hub_apps unavailable — using the config fallback. Run supabase_setup.sql.", "err");
    }
    renderTabs();
    go("apps");
  }

  function toggleTheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    $("themeBtn").textContent = dark ? "Dark" : "Light";
    try { localStorage.setItem("bp-theme", dark ? "light" : "dark"); } catch (_) {}
  }
  function initTheme() {
    let t = "light";
    try { t = localStorage.getItem("bp-theme") || "light"; } catch (_) {}
    document.documentElement.setAttribute("data-theme", t);
    $("themeBtn").textContent = t === "dark" ? "Light" : "Dark";
  }

  /* -------------------------------------------------------------------- tabs */

  /* Data Intake is held to a named list rather than to a role. It was open to
     everyone on the theory that each destination gates itself — and it does,
     in renderIntake() via DB.intakeRoles(), with RLS behind that. But a single
     drop rewrites whole divisions across three apps at once, and any editor in
     any one app could reach the screen and start a publish. The list is in
     CFG.INTAKE_EMAILS; Blueprint admin deliberately does not confer it, since
     admin here means admin of one app's role table.

     This hides the tab and refuses the navigation. It is not the security
     boundary: what a person may write is still their row in each app's role
     table and the RLS policies on the destination tables. */
  const INTAKE_EMAILS = (CFG.INTAKE_EMAILS || [])
    .map(BP.normalizeEmail).filter(Boolean);

  function mayIntake() {
    const me = BP.normalizeEmail(state.email || "");
    if (!me) return false;
    // The mock has no real identities and cannot reach production, so the dev
    // account stands in for the owner there — otherwise the tab would be
    // unreachable in local dev and in the UI tests without editing config.
    if (!DB.LIVE && me === BP.normalizeEmail(CFG.DEV_USER || "")) return true;
    return INTAKE_EMAILS.indexOf(me) !== -1;
  }

  const TABS = [
    { id: "apps", label: "Apps" },
    { id: "intake", label: "Data Intake", gate: mayIntake,
      deny: "Data Intake is limited to the people who maintain the imports." },
    { id: "users", label: "Users", gate: () => state.isAdmin,
      deny: "That section is for admins only." },
    { id: "health", label: "Health" }
  ];

  function renderTabs() {
    $("tabs").innerHTML = TABS
      .filter(t => !t.gate || t.gate())
      .map(t => '<button class="tab' + (state.tab === t.id ? " active" : "") +
                '" data-tab="' + t.id + '">' + t.label + "</button>").join("");
    $("tabs").querySelectorAll("[data-tab]").forEach(b => {
      b.onclick = () => go(b.dataset.tab);
    });
  }

  // Gate here as well as in renderTabs(). Hiding a tab button is presentation,
  // not access control — this refuses the navigation itself, so a stale state
  // or a console call cannot land someone on the people-management screen or
  // on Data Intake. The real boundary is still server-side: the list RPCs and
  // the destination tables' RLS refuse regardless of what the client renders.
  function allowed(tab) {
    const t = TABS.find(x => x.id === tab);
    if (!t) return false;
    return !t.gate || t.gate();
  }

  function go(tab) {
    if (!allowed(tab)) {
      const t = TABS.find(x => x.id === tab);
      if (tab !== "apps") toast((t && t.deny) || "You do not have access to that section.", "err");
      tab = "apps";
    }
    state.tab = tab;
    renderTabs();
    render();
  }

  /* Renders are generation-guarded.
     renderUsers and renderHealth await network data before writing to #view, so
     switching tabs mid-load left a stale renderer to finish and overwrite the tab
     you had moved to. Each render takes a token; any write after an await is
     skipped once a newer render has started. The alternative — disabling the tabs
     while loading — punishes the user for a bug in our sequencing. */
  let renderSeq = 0;

  function render() {
    const v = $("view");
    if (!allowed(state.tab)) { state.tab = "apps"; renderTabs(); }
    const token = ++renderSeq;
    const stale = () => token !== renderSeq;
    if (state.tab === "apps") return renderApps(v);
    if (state.tab === "intake") return renderIntake(v, stale);
    if (state.tab === "users") return renderUsers(v, stale);
    if (state.tab === "health") return renderHealth(v, stale);
  }

  /* --------------------------------------------------------------- shared UI */

  function iconHtml(app, cls) {
    const c = cls || "ic";
    // Placeholder class differs by size but the styling is deliberately the same
    // brand blue in both, so a generated mark stays readable in light and dark.
    const phClass = c === "ic" ? "ic-ph" : c + " ph";
    const initials = esc(shortOf(app));

    if (app.icon_url) {
      /* A configured icon that fails to load is also a missing asset, so it falls
         back to the identical flagged placeholder rather than an unstyled gap.

         The placeholder rides along as data attributes and is built by the
         delegated listener below — there is deliberately no inline onerror any
         more. The old one interpolated the initials into a JS string literal
         nested inside an HTML attribute, and the browser HTML-decodes an
         attribute before the JS parser ever sees it: esc()'s &#39; turned back
         into a bare ' and closed the string. An app named "Alpha 'Beta" has
         initials A'B, so the escaping was defeated by the very character it
         existed to neutralise. Data attributes are read through .dataset, which
         is never parsed as code, so there is no second context to escape for. */
      return '<img class="' + c + '" src="' + esc(app.icon_url) + '" alt="" ' +
             'data-ph-class="' + esc(phClass) + '" data-ph-text="' + initials + '">';
    }
    return '<div class="' + phClass + '" title="No logo.svg published yet">' +
           initials + "</div>";
  }

  /* Swap a failed icon for its placeholder. Registered once, in the capture
     phase, because an image's error event does not bubble — capture is the only
     phase that reaches the document at all. One listener therefore covers every
     icon Blueprint will ever draw, including ones written into innerHTML long
     after this ran, which is what lets iconHtml stay a pure string function. */
  document.addEventListener("error", e => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.dataset || img.dataset.phText == null) return;
    const ph = document.createElement("div");
    ph.className = img.dataset.phClass || "ic-ph";
    ph.title = "Logo failed to load";
    ph.textContent = img.dataset.phText;   // text, not markup — nothing to escape
    if (img.parentNode) img.parentNode.replaceChild(ph, img);
  }, true);

  function shortOf(app) {
    return (app.name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase();
  }

  // How the app is entered. Three tones so an authenticated internal tool is
  // never rendered with the amber "public" treatment reserved for open access.
  function authChipHtml(app) {
    const k = BP.authKind(app), m = BP.authMeta(app);
    if (m.tone === "ok")   return '<span class="dot ok"></span> ' + esc(m.label);
    if (m.tone === "warn") return '<span class="pubtag" title="' + esc(m.note) + '">' +
                                  esc(m.label) + "</span>";
    return '<span class="chip" title="' + esc(m.note) + '">' + esc(m.label) + "</span>" +
           (k === "entra" ? "" : "");
  }

  function authorHtml(app) {
    const a = BP.parseAuthors(app.authors);
    if (!a.length) return "";
    // Chips live in their own non-wrapping track so two authors always share a
    // line. Previously the label competed with them for the same row and pushed
    // the second author onto its own line on anything but a wide tile.
    return '<div class="apptile-auth"><span class="lbl">' +
      (a.length > 1 ? "Authors" : "Author") + "</span>" +
      '<span class="who-list">' +
      a.map(n => '<span class="who" title="' + esc(n) + '"><span class="av">' +
                 esc(BP.initialsOf(n)) + '</span><span class="nm">' + esc(n) +
                 "</span></span>").join("") +
      "</span></div>";
  }

  /* ------------------------------------------------------------------- APPS */

  function renderApps(v) {
    const admin = state.isAdmin;
    const header =
      '<div class="toolbar">' +
        (admin
          ? '<button class="btn mini' + (state.appsMode === "tiles" ? "" : " ghost") + '" data-mode="tiles">Tiles</button>' +
            '<button class="btn mini' + (state.appsMode === "manage" ? "" : " ghost") + '" data-mode="manage">Manage</button>'
          : "") +
        '<span class="count">' + state.apps.length + " app" + (state.apps.length === 1 ? "" : "s") + "</span>" +
      "</div>";

    v.innerHTML = header + (state.appsMode === "manage" && admin ? manageHtml() : tilesHtml());

    v.querySelectorAll("[data-mode]").forEach(b => {
      b.onclick = () => { state.appsMode = b.dataset.mode; render(); };
    });
    v.querySelectorAll("[data-open]").forEach(b => {
      b.onclick = () => window.open(b.dataset.open, "_blank", "noopener");
    });
    if (state.appsMode === "manage" && admin) wireManage(v);
  }

  function tilesHtml() {
    const apps = BP.sortApps(state.apps).filter(a => state.isAdmin || a.active !== false);
    const q = state.query.trim().toLowerCase();
    const shown = q
      ? apps.filter(a => (a.name + " " + (a.description || "") + " " +
          BP.parseAuthors(a.authors).join(" ")).toLowerCase().includes(q))
      : apps;

    if (!shown.length) return '<div class="panel"><div class="empty">No apps match that search.</div></div>';

    return '<div class="tilegrid">' + shown.map(a => {
      return '<button class="apptile' + (a.active === false ? " inactive" : "") +
        '" data-open="' + esc(a.url) + '">' +
        '<div class="apptile-h">' + iconHtml(a) +
          "<div><h3>" + esc(a.name) + "</h3>" +
          '<div class="sub" title="' + esc(a.url) + '">' + esc(BP.shortenUrl(a.url, 40)) + "</div></div></div>" +
        "<p>" + esc(a.description || "") + "</p>" +
        authorHtml(a) +
        '<div class="apptile-f">' +
          authChipHtml(a) +
          (a.active === false ? '<span class="cat-tag">inactive</span>' : "") +
          '<span class="go">Open &rarr;</span>' +
        "</div></button>";
    }).join("") + "</div>";
  }

  function manageHtml() {
    const apps = BP.sortApps(state.apps);
    return '<div class="panel"><div class="panel-h">Registered apps<span class="sp"></span>' +
      '<button class="btn mini ghost" data-addapp>&#43; Add an app</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>URL</th>' +
      "<th>Author</th><th>Sign-in</th><th>Roles here</th><th>Active</th><th></th></tr></thead><tbody>" +
      apps.map(a =>
        "<tr>" +
          "<td>" + iconHtml(a, "ic-sm") + "</td>" +
          "<td><b>" + esc(a.name) + "</b></td>" +
          '<td class="urlc" title="' + esc(a.url) + '">' + esc(BP.shortenUrl(a.url, 44)) + "</td>" +
          "<td>" + esc(BP.formatAuthors(a.authors)) + "</td>" +
          "<td>" + authChipHtml(a) + "</td>" +
          "<td>" + (BP.isManaged(a)
            ? '<span class="chip">managed here</span>'
            : '<span class="cat-tag">not managed here</span>') + "</td>" +
          '<td><input type="checkbox" data-active="' + esc(a.slug) + '"' +
            (a.active === false ? "" : " checked") + "></td>" +
          '<td class="num"><button class="linkbtn" data-edit="' + esc(a.slug) + '">Edit</button> ' +
          '<button class="linkbtn danger" data-remove="' + esc(a.slug) + '">Remove</button></td>' +
        "</tr>").join("") +
      "</tbody></table></div>" +
      '<div class="panel-b" style="border-top:1px solid var(--line)"><p class="hint" style="margin:0">' +
      "<b>Sign-in</b> is how people get in. <b>Roles here</b> is a different question: only apps " +
      "using this hub's sign-in have roles Blueprint can administer. An app behind Entra ID " +
      "is fully protected, but its access is managed in Entra, so it appears as a tile only. " +
      "Any app can be removed: that deletes only the Blueprint registry row, so no role data is " +
      "touched and nobody loses access." +
      "</p></div></div>";
  }

  function wireManage(v) {
    v.querySelector("[data-addapp]").onclick = openAddApp;

    v.querySelectorAll("[data-active]").forEach(cb => {
      cb.onchange = async () => {
        const app0 = state.apps.find(x => x.slug === cb.dataset.active);
        const r = await DB.updateApp(cb.dataset.active, { active: cb.checked }, app0);
        if (!r.ok) { cb.checked = !cb.checked; return toast(r.error, "err"); }
        const a = state.apps.find(x => x.slug === cb.dataset.active);
        if (a) a.active = cb.checked;
        toast(a.name + (cb.checked ? " shown" : " hidden"), "ok");
      };
    });

    v.querySelectorAll("[data-edit]").forEach(b => {
      b.onclick = () => openEditApp(state.apps.find(a => a.slug === b.dataset.edit));
    });

    v.querySelectorAll("[data-remove]").forEach(b => {
      b.onclick = () => doRemoveApp(state.apps.find(a => a.slug === b.dataset.remove));
    });
  }

  // The confirm text enumerates what is NOT affected, because "Remove" beside a
  // production app should never feel ambiguous.
  async function doRemoveApp(app) {
    const im = BP.removalImpact(app);
    const body =
      "<p>Remove <b>" + esc(app.name) + "</b> from Blueprint?</p>" +
      '<div class="warnbox"><b>What this does</b><ul>' +
        "<li>Deletes the Blueprint registry row, so the tile disappears.</li>" +
        "<li>Loses its description, authors and icon — you would re-enter them to add it back.</li>" +
      "</ul></div>" +
      '<div class="panel-inset"><b>What this does not do</b><ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted)">' +
        "<li>The app keeps running at its own URL.</li>" +
        (im.roleTable
          ? "<li><code>" + esc(im.roleTable) + "</code> is not touched — <b>nobody loses access.</b></li>"
          : "<li>It has no role table, so there is no access to lose.</li>") +
        "<li>No user, role or division data is deleted anywhere.</li>" +
      "</ul></div>" +
      '<p class="hint">If you only want to hide the tile for now, cancel and use the Active toggle instead.</p>';

    if (!(await confirmBox("Remove " + app.name, body, "Remove app", true))) return;

    const r = await DB.removeApp(app.slug);
    if (!r.ok) return toast(r.error, "err");
    state.apps = state.apps.filter(a => a.slug !== app.slug);
    toast(app.name + " removed from Blueprint", "ok");
    render();
  }

  function appFormHtml(app) {
    const a = app || {};   // `app` (may be null for a new app) drives the default
    return '<div class="field-row"><div><label class="fld">Name</label>' +
      '<input type="text" id="afName" value="' + esc(a.name || "") + '" placeholder="e.g. Plan Library"></div>' +
      '<div><label class="fld">URL</label>' +
      '<input type="text" id="afUrl" value="' + esc(a.url || "") + '" placeholder="https://…"' +
      (app ? " " : "") + "></div></div>" +
      '<div class="field-row"><div><label class="fld">Description</label>' +
      '<input type="text" id="afDesc" value="' + esc(a.description || "") + '"></div></div>' +
      '<div class="field-row"><div><label class="fld">Authors</label>' +
      '<input type="text" id="afAuthors" value="' + esc(BP.parseAuthors(a.authors).join(", ")) + '">' +
      '<p class="hint">Comma-separated. Shown on the tile so people know who to ask.</p></div>' +
      '<div><label class="fld">Icon</label>' +
      '<div class="iconrow">' +
        '<div class="iconprev" id="afPrev"></div>' +
        '<div class="iconrow-b">' +
          '<input type="text" id="afIcon" value="' + esc(a.icon_url || "") + '" placeholder="https://… or upload">' +
          '<div class="iconbtns">' +
            '<button class="btn mini ghost" id="afDetect">Detect</button>' +
            '<button class="btn mini ghost" id="afUpload">Upload…</button>' +
            '<button class="btn mini ghost" id="afClear">Clear</button>' +
          "</div></div></div>" +
      '<input type="file" id="afFile" accept="image/*" class="hidden">' +
      '<p class="hint" id="afIconNote">Detect checks the usual icon locations. ' +
      'Apps behind sign-in redirect those to a login page, so upload the image instead.</p></div></div>' +
      '<div class="field-row"><div><label class="fld">Sign-in</label>' +
      '<select class="std" id="afAuth" style="width:100%">' +
      Object.keys(BP.AUTH_KINDS).map(k => {
        const meta = BP.AUTH_KINDS[k];
        // "Shared sign-in" is only selectable for an app that already has a role
        // table — wiring is set in SQL, never granted by this form.
        const disabled = k === "shared" && !(a && a.role_table);
        const current = app ? BP.authKind(app) : "entra";
        const selected = current === k;
        return '<option value="' + k + '"' + (selected ? " selected" : "") +
               (disabled ? " disabled" : "") + ">" + esc(meta.label) +
               (disabled ? " — needs a role table" : "") + "</option>";
      }).join("") + "</select>" +
      '<p class="hint" id="afAuthNote"></p></div></div>' +
      '<div id="afMsg" class="msg"></div>';
  }

  function wireAuthNote() {
    const sel = $("afAuth"), note = $("afAuthNote");
    if (!sel || !note) return;
    const sync = () => { note.textContent = (BP.AUTH_KINDS[sel.value] || {}).note || ""; };
    sel.onchange = sync; sync();
  }

  function readAppForm() {
    return {
      name: $("afName").value.trim(),
      url: $("afUrl").value.trim(),
      description: $("afDesc").value.trim(),
      authors: $("afAuthors").value,
      icon_url: $("afIcon").value.trim() || null,   // validated by validateIconUrl
      auth_kind: ($("afAuth") || {}).value
    };
  }

  /* Probe one candidate by trying to load it as an image. Cross-origin image
     loading needs no CORS, which is what makes this work at all — we cannot read
     another site's HTML to find its <link rel="icon">.
     Resolves to null on failure or timeout; never rejects. */
  function probeImage(src, timeoutMs) {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;
      const done = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done(null), timeoutMs || 5000);
      img.onload = () => done({ src, w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => done(null);
      img.src = src;
    });
  }

  /* All candidates are probed in parallel, then the highest-priority success
     wins. Sequential probing would be simpler but ~36 candidates × a timeout each
     is unacceptably slow when a site has no icon at all; parallel keeps it to one
     timeout total while core.js's ordering still decides which result is used. */
  async function detectIcon(url) {
    const candidates = BP.iconCandidates(url);
    if (!candidates.length) return null;
    const results = await Promise.all(candidates.map(c => probeImage(c)));
    return BP.bestIcon(results);
  }

  // Downscale to a small square and return a data URI. SVGs are kept as-is —
  // rasterising a scalable icon to put it in a 40px tile throws away the one
  // advantage it has.
  function fileToIconDataUrl(file, size) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("No file chosen."));
      if (!/^image\//.test(file.type || "")) return reject(new Error("That is not an image file."));

      if (/svg/.test(file.type)) {
        if (file.size > BP.MAX_DATA_ICON_BYTES) return reject(new Error("That SVG is too large."));
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error("Could not read that file."));
        return r.readAsDataURL(file);
      }

      const r = new FileReader();
      r.onerror = () => reject(new Error("Could not read that file."));
      r.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That image could not be decoded."));
        img.onload = () => {
          try {
            const n = size || 64;
            const c = document.createElement("canvas");
            c.width = n; c.height = n;
            const ctx = c.getContext("2d");
            // contain, centred — never distort someone's logo to fit a square
            const scale = Math.min(n / img.width, n / img.height);
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            ctx.drawImage(img, Math.round((n - w) / 2), Math.round((n - h) / 2), w, h);
            const out = c.toDataURL("image/png");
            if (out.length > BP.MAX_DATA_ICON_BYTES) {
              return reject(new Error("That image is too large to store inline."));
            }
            resolve(out);
          } catch (e) { reject(new Error("Could not process that image.")); }
        };
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });
  }

  function renderIconPreview() {
    const box = $("afPrev");
    if (!box) return;
    const v = ($("afIcon").value || "").trim();
    if (!v) {
      box.innerHTML = '<div class="ic-ph" title="No icon — a tile will be generated">' +
        esc(($("afName") ? shortOf({ name: $("afName").value }) : "?")) + "</div>";
      return;
    }
    box.innerHTML = '<img class="ic" src="' + esc(v) + '" alt="" ' +
      'onerror="this.parentNode.innerHTML=\'<div class=&quot;ic-ph&quot; title=&quot;This icon did not load&quot;>!</div>\'">';
  }

  function wireDetect() {
    const btn = $("afDetect");
    if (!btn) return;

    renderIconPreview();
    $("afIcon").oninput = renderIconPreview;
    $("afName") && ($("afName").oninput = renderIconPreview);

    $("afClear").onclick = () => {
      $("afIcon").value = "";
      renderIconPreview();
      $("afIconNote").textContent = "Cleared — a tile will be generated from the name.";
    };

    $("afUpload").onclick = () => $("afFile").click();
    $("afFile").onchange = async () => {
      const note = $("afIconNote");
      try {
        const url = await fileToIconDataUrl($("afFile").files[0], 64);
        $("afIcon").value = url;
        renderIconPreview();
        note.textContent = "Image stored with the app. Works regardless of sign-in.";
      } catch (e) {
        note.textContent = e.message || "Could not use that image.";
      }
      $("afFile").value = "";
    };
    btn.onclick = async () => {
      const note = $("afIconNote");
      const u = BP.validateUrl($("afUrl").value);
      if (!u.ok) { note.textContent = u.error; return; }

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "Looking…";
      note.textContent = "Checking common icon locations…";

      const found = await detectIcon(u.url);

      btn.disabled = false;
      btn.textContent = label;
      if (found) {
        $("afIcon").value = found.src;
        renderIconPreview();
        const shown = found.src.replace(u.url, "").replace(/^https:\/\//, "");
        note.textContent = "Found " + shown +
          (BP.isScalableIcon(found.src) ? " (scalable)"
            : found.w ? " (" + found.w + "×" + found.h + ")" : "") + ".";
      } else {
        // Two causes look identical from here, and guessing between them would be
        // worse than naming both. An app behind sign-in redirects even
        // /favicon.ico to a login page, which cannot be decoded as an image.
        note.textContent = "Nothing found. Either this site publishes no icon at a " +
          "usual location, or it requires sign-in and redirects icon requests to a " +
          "login page — detection cannot get past that. Use Upload to store the " +
          "image with the app instead.";
      }
    };
  }

  function openAddApp() {
    modal("Add an app",
      appFormHtml(null) +
      '<div class="warnbox"><b>Blueprint will not manage this app\'s roles.</b><ul>' +
      "<li>A tile, a URL, an author, an icon and how people sign in — all of that works now.</li>" +
      "<li>Most internal apps belong here as <b>Lennar sign-in</b>: protected by Entra ID, with " +
      "access managed in Entra rather than in this hub.</li>" +
      "<li>Only apps using this hub's own sign-in can be administered here, and that needs a role " +
      "table and two RPCs in the database first. It cannot be granted from this form — a console " +
      "that queried whatever table someone typed would be a probing tool.</li>" +
      "</ul></div>" +
      '<div class="modal-actions"><button class="btn ghost" data-no>Cancel</button>' +
      '<button class="btn" data-yes>Add app</button></div>',
      (ov, close) => {
        wireDetect(); wireAuthNote();
        ov.querySelector("[data-no]").onclick = close;
        ov.querySelector("[data-yes]").onclick = async () => {
          const r = await DB.addApp(readAppForm(), state.apps);
          if (!r.ok) {
            const m = $("afMsg");
            m.className = "msg err";
            m.innerHTML = r.errors.map(esc).join("<br>");
            return;
          }
          state.apps = BP.sortApps(state.apps.concat([r.app]));
          close();
          toast(r.app.name + " added as launcher-only", "ok");
          render();
        };
      });
  }

  function openEditApp(app) {
    modal("Edit " + app.name,
      appFormHtml(app) +
      (BP.isManaged(app)
        ? '<p class="hint">This app is managed (<code>' + esc(app.role_table) + '</code>). ' +
          "Its wiring — role table and RPC names — is set in SQL and cannot be edited here.</p>"
        : "") +
      '<div class="modal-actions"><button class="btn ghost" data-no>Cancel</button>' +
      '<button class="btn" data-yes>Save</button></div>',
      (ov, close) => {
        wireDetect(); wireAuthNote();
        ov.querySelector("[data-no]").onclick = close;
        ov.querySelector("[data-yes]").onclick = async () => {
          const form = readAppForm();
          const u = BP.validateUrl(form.url);
          if (!u.ok) { const m = $("afMsg"); m.className = "msg err"; m.textContent = u.error; return; }
          form.url = u.url;
          const ic = BP.validateIconUrl(form.icon_url);
          if (!ic.ok) { const m = $("afMsg"); m.className = "msg err"; m.textContent = ic.error; return; }
          form.icon_url = ic.url;
          const r = await DB.updateApp(app.slug, form, app);
          if (!r.ok) { const m = $("afMsg"); m.className = "msg err"; m.textContent = r.error; return; }
          Object.assign(app, r.patch);
          state.apps = BP.sortApps(state.apps);
          close();
          toast(app.name + " updated", "ok");
          render();
        };
      });
  }

  /* ------------------------------ USERS + ACCESS ---------------------------
     Users and Provision are one tab. A person's access is a single thing, so
     roles, divisions and credential links are edited in one place — splitting
     them meant divisions could be set when provisioning but never changed
     afterwards, which was a real gap.

     The table is a read-only summary; all editing happens in the per-person
     access editor. That keeps the row narrow as more apps are added, and gives
     division checkboxes somewhere sensible to live.
     ---------------------------------------------------------------------- */

  async function renderUsers(v, stale) {
    stale = stale || (() => false);
    v.innerHTML = '<div class="panel"><div class="empty">Loading users…</div></div>';

    // divisions are needed by the access editor; fetch once per app
    for (const app of BP.managedApps(state.apps)) {
      if (!state.divisions[app.slug]) state.divisions[app.slug] = await DB.divisionsFor(app);
      if (stale()) return;
    }

    const { rows, failures } = await DB.loadUsers(state.apps);
    if (stale()) return;          // user switched tabs while this was loading
    state.users = rows;
    // Kept, not just rendered: an app whose roles could not be read may hold a
    // row we do not know about, which is enough to refuse a removal.
    state.userFailures = failures.map(f => f.app);

    const managed = BP.managedApps(state.apps);
    const shown = BP.filterUsers(rows, state.query);
    const admins = rows.filter(BP.isAdminAnywhere).length;
    const never = rows.filter(r => !r.lastSignIn).length;

    let html = "";
    if (failures.length) {
      html += '<div class="warnbox"><b>Some role lists could not be read</b><ul>' +
        failures.map(f => "<li>" + esc(f.app) + ": " + esc(f.error) + "</li>").join("") +
        "</ul></div>";
    }

    html += '<div class="kpis">' +
      kpi(rows.length, "Accounts") +
      kpi(admins, "Admins") +
      kpi(rows.filter(r => BP.explicitRoleCount(r) > 0).length, "With explicit roles") +
      kpi(never, "Never signed in", never > 0) +
      "</div>";

    html += '<div class="toolbar">' +
      '<button class="btn mini" id="usAdd">&#43; Add a user</button>' +
      '<span class="count">' + shown.length + " of " + rows.length + " shown</span></div>";

    html += '<div class="panel"><div class="table-wrap"><table><thead><tr><th>Email</th>' +
      managed.map(a => "<th>" + esc(a.name) + "</th>").join("") +
      (DB.LIVE ? "" : "<th>Last sign-in</th>") + "<th></th></tr></thead><tbody>" +
      (shown.length ? shown.map(r => userRow(r, managed)).join("")
        : '<tr><td colspan="' + (managed.length + 3) + '"><div class="empty">No users match.</div></td></tr>') +
      "</tbody></table></div>" +
      '<div class="panel-b" style="border-top:1px solid var(--line)"><p class="hint" style="margin:0">' +
      "“implicit” means no row in that app's role table — everyone at " + esc(CFG.ALLOWED_DOMAIN) +
      " can read by default. Roles are independent per app: an editor in one need not be an editor " +
      "in another, and there is deliberately no control that changes all of them at once. " +
      "To take someone off entirely, open Manage access and use Remove access — clearing " +
      "every role only drops them to implicit viewer, which is not the same thing." +
      "</p></div></div>";

    html += '<div class="panel"><div class="panel-h">Outstanding invites<span class="sp"></span>' +
      '<button class="btn mini ghost" id="pvRefresh">Refresh</button></div>' +
      '<div id="pvPending"><div class="empty">Loading…</div></div></div>';

    if (stale()) return;
    v.innerHTML = html;

    $("usAdd").onclick = () => openAccess(null);
    $("pvRefresh").onclick = loadPending;
    v.querySelectorAll("[data-manage]").forEach(b => {
      b.onclick = () => openAccess(b.dataset.manage);
    });

    loadPending(stale);

    if (state.prefillEmail) {
      const e = state.prefillEmail;
      state.prefillEmail = null;
      openAccess(e);
    }
  }

  function kpi(n, label, warn) {
    return '<div class="kpi' + (warn ? " warn" : "") + '"><span class="n">' + n +
      '</span><span class="l">' + esc(label) + "</span></div>";
  }

  function userRow(r, managed) {
    return '<tr><td><b>' + esc(r.email.split("@")[0]) + "</b>@" + esc(r.email.split("@")[1]) + "</td>" +
      managed.map(app => {
        const cur = r.roles[app.slug] || { role: CFG.DEFAULT_ROLE, explicit: false, divisions: [] };
        if (!cur.explicit) return '<td><span class="norole">implicit viewer</span></td>';
        const divs = (cur.divisions || []).length
          ? (cur.divisions || []).map(d => '<span class="chip">' + esc(divLabel(app, d)) + "</span>").join("")
          : ((app.division_scoped_roles || []).indexOf(cur.role) !== -1
              ? '<span class="pubtag">no divisions</span>' : "");
        return "<td><b>" + esc(cur.role) + "</b> " + divs + "</td>";
      }).join("") +
      (DB.LIVE ? "" : "<td>" + esc(BP.relativeDay(r.lastSignIn)) + "</td>") +
      '<td class="num"><button class="linkbtn" data-manage="' + esc(r.email) + '">Manage access</button></td></tr>';
  }

  function divLabel(app, key) {
    const d = (state.divisions[app.slug] || []).find(x => x.key === key);
    return d ? d.label : key;
  }

  /* --------------------------- access editor (was Provision) ------------- */

  const IMPLICIT = "__implicit__";

  function accessCard(app, cur) {
    const divs = state.divisions[app.slug] || [];
    const role = cur ? (cur.explicit ? cur.role : IMPLICIT) : IMPLICIT;
    const scoped = (app.division_scoped_roles || []).length > 0;
    const on = role !== IMPLICIT;
    const selected = (cur && cur.divisions) || [];

    return '<div class="grantcard' + (on ? " on" : "") + '" data-card="' + esc(app.slug) + '">' +
      '<div class="head" style="font-weight:700;color:var(--navy);font-size:13.5px">' + esc(app.name) + "</div>" +
      '<div class="r">Role <select class="rolesel" data-r="' + esc(app.slug) + '">' +
        '<option value="' + IMPLICIT + '"' + (role === IMPLICIT ? " selected" : "") + ">— implicit viewer —</option>" +
        (app.roles || []).map(x => '<option value="' + esc(x) + '"' +
          (x === role ? " selected" : "") + ">" + esc(x) + "</option>").join("") +
      "</select></div>" +
      (scoped && divs.length
        ? '<div class="r" data-divwrap="' + esc(app.slug) + '"><div class="divchks" data-divs="' + esc(app.slug) + '">' +
          divs.map(d => '<label class="divchk"><input type="checkbox" value="' + esc(d.key) + '"' +
            (selected.indexOf(d.key) !== -1 ? " checked" : "") + "> " + esc(d.label) + "</label>").join("") +
          "</div></div>"
        : '<div class="r">' + (divs.length ? "Single division" : "No division scoping") + "</div>") +
      "</div>";
  }

  function openAccess(email) {
    const isNew = !email;
    const row = email ? state.users.find(u => u.email === email) : null;
    const managed = BP.managedApps(state.apps);

    const body =
      (isNew
        ? '<div class="field-row"><div><label class="fld">Work email</label>' +
          '<input type="email" id="acEmail" placeholder="name@lennar.com"></div></div>'
        : '<p class="hint" style="margin:0 0 12px">' + esc(email) + "</p>") +

      '<label class="fld">Access per app</label>' +
      '<p class="hint" style="margin:0 0 8px">Each app is set independently. “Implicit viewer” removes the ' +
      "explicit role row — they keep the read access everyone at " + esc(CFG.ALLOWED_DOMAIN) + " has. " +
      "Division checkboxes apply only to roles that are division-scoped.</p>" +
      '<div class="grantgrid">' + managed.map(a => accessCard(a, row && row.roles[a.slug])).join("") + "</div>" +

      '<label class="divchk" style="margin-top:16px;font-size:13px">' +
      '<input type="checkbox" id="acLink"' + (isNew ? " checked" : "") + "> " +
      "Also generate a credential link" +
      (isNew ? " (needed for a new account)" : " (only if they need to set a password)") +
      "</label>" +

      '<div id="acMsg" class="msg"></div><div id="acOut"></div>' +
      '<div class="modal-actions"><button class="btn ghost" data-no>Cancel</button>' +
      '<button class="btn" data-yes>' + (isNew ? "Create access" : "Save changes") + "</button></div>" +

      /* Offboarding lives here rather than on the table row for the same reason
         everything else does: a person's access is one thing, edited in one
         place. Below the actions and boxed off, because it is not a variant of
         Save — it is the end of the account. */
      (isNew ? "" : removeZoneHtml(email));

    modal(isNew ? "Add a user" : "Manage access", body, (ov, close) => {
      // enable/disable division checkboxes to match the chosen role
      managed.forEach(app => {
        const sel = ov.querySelector('[data-r="' + CSS.escape(app.slug) + '"]');
        const sync = () => {
          const scopedRole = (app.division_scoped_roles || []).indexOf(sel.value) !== -1;
          const wrap = ov.querySelector('[data-divs="' + CSS.escape(app.slug) + '"]');
          if (wrap) wrap.querySelectorAll("input").forEach(i => { i.disabled = !scopedRole; });
          ov.querySelector('[data-card="' + CSS.escape(app.slug) + '"]')
            .classList.toggle("on", sel.value !== IMPLICIT);
        };
        sel.onchange = sync;
        sync();
      });

      ov.querySelector("[data-no]").onclick = close;
      ov.querySelector("[data-yes]").onclick = () => saveAccess(ov, isNew, email, managed);

      const rm = ov.querySelector("[data-remove-user]");
      if (rm) rm.onclick = () => { close(); doRemoveUser(email); };
    });
  }

  /* ------------------------------- remove access ---------------------------
     "Remove access" means the login, not the roles. Dropping every app to
     implicit viewer looks like removal and is not: everyone at ALLOWED_DOMAIN
     keeps read access by default, so the one thing that actually takes access
     away is deleting the shared auth row — which is what the sibling apps'
     "Delete the login" buttons have always done, and what Blueprint could not.
     ---------------------------------------------------------------------- */

  function removeZoneHtml(email) {
    const plan = BP.buildRemovalPlan(email, state.users, state.apps, {
      operatorEmail: state.email,
      operatorAdminSlugs: state.adminSlugs,
      failedApps: state.userFailures
    });

    // A refusal is shown, not hidden. A greyed-out button with no reason is how
    // someone concludes the feature is broken and goes looking for a workaround.
    return '<div class="dangerzone"><b>Remove access</b>' +
      '<p class="hint">Deletes their login, so they cannot sign in to any tool. ' +
      "Clearing roles above only drops them to implicit viewer.</p>" +
      (plan.ok
        ? '<button class="btn danger mini" data-remove-user>Remove access…</button>'
        : '<p class="msg err" style="display:block;margin:0">' + esc(plan.error) + "</p>") +
      "</div>";
  }

  async function doRemoveUser(email) {
    const plan = BP.buildRemovalPlan(email, state.users, state.apps, {
      operatorEmail: state.email,
      operatorAdminSlugs: state.adminSlugs,
      failedApps: state.userFailures
    });
    if (!plan.ok) return toast(plan.error, "err");

    const body =
      "<p>Remove <b>" + esc(plan.email) + "</b> from every tool?</p>" +
      '<div class="warnbox"><b>What this does</b><ul>' +
        (plan.clears.length
          ? "<li>Deletes their role in " +
            plan.clears.map(c => "<b>" + esc(c.name) + "</b> (" + esc(c.role) + ")").join(", ") +
            ".</li>"
          : "<li>They hold no explicit role anywhere, so no role row is deleted.</li>") +
        "<li>Deletes the shared login, so they can no longer sign in to " +
        "<b>any</b> of the tools — not just the ones they had a role in.</li>" +
        "<li>Cannot be undone. Coming back means a fresh invite and re-granting " +
        "every role by hand.</li>" +
      "</ul></div>" +
      (plan.orphanedAdmins.length
        ? '<div class="warnbox"><b>They are the only admin in ' +
          plan.orphanedAdmins.map(esc).join(" and ") + "</b><ul><li>Removing them leaves " +
          (plan.orphanedAdmins.length > 1 ? "those apps" : "that app") +
          " with nobody who can grant roles or mint credential links. " +
          "Promote someone else first if that is not intended.</li></ul></div>"
        : "") +
      '<div class="panel-inset"><b>What this does not do</b>' +
      '<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted)">' +
        "<li>Nothing they uploaded, published or edited is deleted. Change-log " +
        "entries keep their name.</li>" +
        "<li>Any credential link already generated for this address stays in the " +
        "token table — Blueprint has no access to it. Check <b>Outstanding " +
        "invites</b> below afterwards.</li>" +
      "</ul></div>" +
      '<p class="hint">Deleted via ' + esc(plan.viaApp) + ", the app you are an admin in. " +
      "One login is shared across the suite, so this removes them everywhere.</p>";

    if (!(await confirmTyped("Remove " + plan.email, body, plan.email, "Remove access"))) return;

    const r = await DB.removeUser(plan, state.apps);
    if (!r.ok) return toast(r.error, "err");
    toast(plan.email + " removed — their login is deleted", "ok");
    render();
  }

  function readAccess(ov, managed) {
    const grants = [], clears = [];
    for (const app of managed) {
      const role = ov.querySelector('[data-r="' + CSS.escape(app.slug) + '"]').value;
      if (role === IMPLICIT) { clears.push(app); continue; }
      const wrap = ov.querySelector('[data-divs="' + CSS.escape(app.slug) + '"]');
      const divisions = wrap && (app.division_scoped_roles || []).indexOf(role) !== -1
        ? [...wrap.querySelectorAll("input:checked")].map(i => i.value) : [];
      grants.push({ enabled: true, slug: app.slug, role, divisions });
    }
    return { grants, clears };
  }

  async function saveAccess(ov, isNew, email, managed) {
    const msg = ov.querySelector("#acMsg"), out = ov.querySelector("#acOut");
    msg.className = "msg"; out.innerHTML = "";

    const target = isNew ? ov.querySelector("#acEmail").value : email;
    const v = BP.validateEmail(target, CFG.ALLOWED_DOMAIN);
    if (!v.ok) { msg.className = "msg err"; msg.textContent = v.error; return; }

    const { grants, clears } = readAccess(ov, managed);

    // Validate roles against each app before writing anything.
    const gmap = {};
    for (const g of grants) gmap[g.slug] = g;
    const plan = BP.buildGrantPlan({ grants: gmap }, state.apps);
    if (!plan.ok) { msg.className = "msg err"; msg.textContent = plan.error; return; }

    const btn = ov.querySelector("[data-yes]");
    btn.disabled = true; btn.textContent = "Saving…";

    /* Everything that awaits lives inside this try. The button was disabled and
       relabelled above, and until this was wrapped the ONLY thing that restored
       it was a clean run to the end — so a single rejection anywhere below left
       it stuck on "Saving…" for good, with no error shown and no way to retry
       short of reloading. The finally is the guarantee; the catch is what turns
       a stranded modal into a readable message. */
    try {
      let links = [];
      const results = [];
      for (const g of plan.grants) {
        const app = state.apps.find(a => a.slug === g.slug);
        const r = await DB.setRole(app, v.email, g.role, g.divisions);
        results.push({ app: app.name, text: g.role +
          (g.divisions.length ? " (" + g.divisions.map(d => divLabel(app, d)).join(", ") + ")" : ""),
          ok: r.ok, error: r.error });
      }
      for (const app of clears) {
        const had = state.users.find(u => u.email === v.email);
        if (!had || !had.roles[app.slug] || !had.roles[app.slug].explicit) continue;
        const r = await DB.clearRole(app, v.email);
        results.push({ app: app.name, text: "implicit viewer", ok: r.ok, error: r.error });
      }

      if (ov.querySelector("#acLink").checked) {
        // Everyone needs a password even with no explicit role, so fall back to
        // the shared pool when nothing scoped was granted. That sentinel grant
        // carries a pool and no slug, and provision() reads the pool off it.
        const r = await DB.provision(v.email, plan.grants.length ? plan.grants
          : [{ slug: null, tokenPool: "A" }], state.adminSlugs, state.apps);
        links = r.links || [];
      }

      await renderAccessResult(ov, v, results, links, msg, out);
    } catch (e) {
      msg.className = "msg err";
      msg.textContent = (e && e.message) || "Something went wrong saving access.";
    } finally {
      btn.disabled = false; btn.textContent = isNew ? "Create access" : "Save changes";
    }
  }

  // The reporting half of saveAccess, split out only so the caller's try block
  // stays readable. Nothing here awaits a write; the one await refreshes the
  // table sitting behind the modal.
  async function renderAccessResult(ov, v, results, links, msg, out) {
    const failed = results.filter(r => !r.ok);
    msg.className = "msg " + (failed.length ? "err" : "ok");
    msg.innerHTML = (results.length
      ? "Saved for <b>" + esc(v.email) + "</b>: " + results.map(r =>
          (r.ok ? "" : "<s>") + esc(r.app) + " " + esc(r.text) +
          (r.ok ? "" : "</s> — " + esc(r.error))).join(" &middot; ")
      : "No role changes for <b>" + esc(v.email) + "</b>.");

    if (links.length) {
      out.innerHTML = '<div class="panel-inset">' + links.map(l => {
        if (!l.ok) return '<div class="msg err" style="display:block">Pool ' + esc(l.pool) +
          ": " + esc(l.error) + "</div>";
        return '<label class="fld" style="margin-top:6px">' +
          (l.pool === "B" ? "Community-DB link" : "Credential link") +
          (l.created ? ' <span class="cat-tag">new account</span>' : "") +
          ' <span class="cat-tag">via ' + esc(l.viaApp) + "</span></label>" +
          '<div class="linkrow"><input type="text" readonly value="' + esc(l.url) + '">' +
          '<button class="btn mini ghost" data-copy="' + esc(l.url) + '">Copy</button></div>';
      }).join("") +
        '<p class="hint">Send this directly — no email is sent. Once redeemed, the same password ' +
        "signs them in to every app they have a role in." +
        (links.length > 1
          ? " Two links because Community-DB uses a separate token pool from the other apps."
          : "") + "</p></div>";

      out.querySelectorAll("[data-copy]").forEach(b => {
        b.onclick = async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); toast("Link copied", "ok"); }
          catch (_) { toast("Select and copy manually", "err"); }
        };
      });
    }

    // Refresh the underlying table behind the modal without closing it, so the
    // generated link stays on screen to be copied.
    const { rows } = await DB.loadUsers(state.apps);
    state.users = rows;
    if (!links.length) { ov.remove(); render(); }
  }

  async function loadPending(stale) {
    stale = stale || (() => false);
    const el = $("pvPending");
    if (!el) return;
    const r = await DB.pendingInvites();
    // The element may have been replaced by a different tab's render.
    if (stale() || !document.body.contains(el)) return;
    if (!r.ok) { el.innerHTML = '<div class="empty">' + esc(r.error) + "</div>"; return; }
    if (!r.rows.length) { el.innerHTML = '<div class="empty">No outstanding invite links.</div>'; return; }
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Pool</th>' +
      "<th>Created</th><th>Expires</th></tr></thead><tbody>" +
      r.rows.map(x => "<tr><td>" + esc(x.email) + "</td>" +
        "<td>" + (x.pool === "B" ? '<span class="cat-tag">Community-DB</span>'
                                 : '<span class="cat-tag">shared</span>') + "</td>" +
        "<td>" + esc(BP.relativeDay(x.created_at)) + "</td>" +
        "<td>" + esc(x.expiry.hoursRemaining + "h left") +
        (x.expiry.computed ? ' <span class="cat-tag" title="Pool B stores no expires_at; computed from created_at">computed</span>' : "") +
        "</td></tr>").join("") + "</tbody></table></div>" +
      '<div class="panel-b" style="border-top:1px solid var(--line)"><p class="hint" style="margin:0">' +
      "Tokens themselves are never sent to the browser — this list comes from " +
      "<code>hub_pending_invites()</code>, which does not return them.</p></div>";
  }

  /* ------------------------------------------------------------ DATA INTAKE

     One drop zone for every workbook, instead of a separate upload screen per
     app. The Starts Log feeds Vendor Assignments, Takeoff Flow and the Community
     Map; the RE2 export feeds Vendor Assignments and the Map, and carries both
     divisions in one file. Uploading each of those separately in each app is how
     the apps ended up disagreeing about which communities exist.

     Three things shape this screen:

     · Files arrive separately. The two starts logs come from two permitting
       managers on different days, so an incomplete drop is the normal case. A
       destination missing an input is "waiting", never an error, and never a
       partial publish.

     · Nothing publishes without being shown first. Each destination gets its own
       preview and its own button. One failing destination does not roll back the
       others — there is no transaction spanning three apps, so pretending
       otherwise would be a lie about what happened.

     · The parse runs in a worker. The RE2 export takes about fifteen seconds of
       unbreakable CPU, which on the main thread is a frozen tab.
     ------------------------------------------------------------------------ */

  const INTAKE_KINDS = {
    starts:   { label: "Starts Log",           needsDivision: true },
    re2:      { label: "RE2 Vendor Assignments", needsDivision: false },
    contacts: { label: "Construction Contacts", needsDivision: false },
    flow:     { label: "Flow of Takeoffs",     needsDivision: false },
    unknown:  { label: "Not recognised",       needsDivision: false }
  };

  const intake = {
    files: [],        // { id, name, size, kind, division, status, error, parsed }
    worker: null,
    roles: null,
    current: {},      // published payloads, keyed for diffing
    results: {},      // per-destination publish outcome
    batch: null,      // { done, total, current } while Publish all is running
    busy: false
  };

  function intakeReset() {
    if (intake.worker) {
      // Settle anything still in flight before terminating. A terminated worker
      // sends no reply either, so without this a reset mid-parse strands the
      // same promises a failed boot would.
      const w = intake.worker;
      intake.worker = null;
      if (w._die) w._die("The import was reset before this file finished parsing.");
      w.terminate();
    }
    intake.files = [];
    intake.results = {};
    intake.batch = null;
    intake.busy = false;
  }

  /* The worker is built from a blob so the static site needs no separate build
     step, and it is handed absolute URLs because a blob worker has no useful base
     URL of its own — relative importScripts would resolve against the blob.

     SheetJS is served from vendor/ rather than a CDN. importScripts inside a blob
     worker cannot carry an integrity attribute, so a CDN copy was a third party we
     were trusting on every parse with no way to verify the bytes. Same-origin, the
     file is part of the deploy and is reviewed like the rest of it. It goes through
     the same `base` as the other two imports for the same reason they do. */
  function intakeWorker() {
    if (intake.worker) return intake.worker;
    const base = location.href.replace(/[^/]*$/, "");
    const src = 'importScripts("' + base + 'ingest-worker.js");';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w._urls = {
      xlsx: base + "vendor/xlsx-0.20.3/xlsx.full.min.js",
      ingestCore: base + "ingest-core.js",
      mapCore: base + "map-core.js"
    };

    /* Every intakeAsk that has not settled yet, so a failure of the WORKER —
       as opposed to a failure reported by it — can settle all of them.

       Without this the worst case is silent. A worker whose importScripts 404s,
       or whose script throws while evaluating, never sends a message at all:
       there is no "error" reply to reject on, so every promise stays pending,
       every file sits on "parsing…" for good, and the only way out is a reload
       the operator has no reason to think they need. An error event is the one
       notification the platform does give us, so it has to be wired to the
       promises rather than to nothing. */
    w._pending = new Set();
    const die = why => {
      const waiting = [...w._pending];
      w._pending.clear();
      // The instance is poisoned — a worker that failed to boot will not boot
      // on the next postMessage either. Drop it so the next attempt builds a
      // fresh one instead of posting into something that can never answer.
      if (intake.worker === w) intake.worker = null;
      for (const fail of waiting) fail(new Error(why));
    };
    w._die = die;
    w.onerror = e => die(e && e.message
      ? "The file parser failed to start: " + e.message
      : "The file parser failed to start — it may not have downloaded. "
        + "Reload Blueprint and try again.");
    w.onmessageerror = () =>
      die("The file parser sent a reply that could not be read.");

    intake.worker = w;
    return w;
  }

  // One request/response over the worker, keyed by file id.
  function intakeAsk(message, onProgress) {
    const w = intakeWorker();
    return new Promise((resolve, reject) => {
      // Held by the worker so a boot failure or a reset can settle this promise
      // from the outside; see intakeWorker's `die`.
      const fail = err => { w.removeEventListener("message", handler); reject(err); };
      const handler = e => {
        const d = e.data || {};
        if (d.id !== message.id) return;
        if (d.type === "progress") { if (onProgress) onProgress(d); return; }
        w.removeEventListener("message", handler);
        w._pending.delete(fail);
        if (d.type === "error") reject(new Error(d.message));
        else resolve(d);
      };
      w.addEventListener("message", handler);
      w._pending.add(fail);
      w.postMessage(Object.assign({ urls: w._urls }, message));
    });
  }

  async function intakeAddFiles(fileList) {
    /* Adding a file invalidates every previous outcome message. "Added 6 rows to
       Orlando" was true when it was written, but leaving it on the card while the
       plan underneath has changed means the screen is describing the past and the
       button is describing the future, in the same box. The toast already
       confirmed the publish, and the new preview is what matters now. */
    intake.results = {};

    const incoming = [...fileList].filter(f => /\.(xlsx|xlsm)$/i.test(f.name));
    const rejected = [...fileList].filter(f => !/\.(xlsx|xlsm)$/i.test(f.name));
    for (const r of rejected) {
      intake.files.push({
        id: "f" + Math.random().toString(36).slice(2), name: r.name, size: r.size,
        kind: "unknown", status: "error",
        error: "Only .xlsx and .xlsm workbooks can be read."
      });
    }

    for (const f of incoming) {
      const rec = {
        id: "f" + Math.random().toString(36).slice(2),
        name: f.name, size: f.size, file: f,
        kind: null, division: null, status: "identifying", error: null, parsed: null
      };
      intake.files.push(rec);
    }
    renderIntakeBody();

    // Identify first — cheap, and it lets the UI label every file before the
    // expensive parses begin.
    for (const rec of intake.files.filter(r => r.status === "identifying")) {
      try {
        const buf = await rec.file.arrayBuffer();
        const res = await intakeAsk({ type: "identify", id: rec.id, buffer: buf, fileName: rec.name });
        rec.kind = res.guess.kind;
        rec.division = res.guess.division;
        rec.why = res.guess.why;
        rec.sheetNames = res.sheetNames;
        rec.status = rec.kind === "unknown" ? "unrecognised" : "ready";
        if (rec.kind === "starts" && !rec.division) {
          rec.status = "needs-division";
        }
      } catch (err) {
        rec.status = "error";
        rec.error = err.message;
      }
      renderIntakeBody();
    }

    await intakeParseAll();
  }

  async function intakeParseAll() {
    const todo = intake.files.filter(r => r.status === "ready" && !r.parsed &&
                                          r.kind !== "unknown" && r.kind !== "contacts");
    // Contacts are parsed too, but only the map consumes them.
    const all = intake.files.filter(r => r.status === "ready" && !r.parsed && r.kind !== "unknown");
    for (const rec of all) {
      rec.status = "parsing";
      rec.progress = { stage: "reading", pct: 0 };
      renderIntakeBody();
      try {
        const buf = await rec.file.arrayBuffer();
        const res = await intakeAsk(
          { type: "parse", id: rec.id, buffer: buf, kind: rec.kind, division: rec.division, fileName: rec.name },
          p => { rec.progress = { stage: p.stage, pct: p.pct }; renderIntakeProgress(rec); }
        );
        rec.parsed = res;
        rec.status = "parsed";
        // Free the File handle: the RE2 workbook's parsed form is already large
        // and holding the original buffer as well doubles it for no reason.
        rec.file = null;
      } catch (err) {
        rec.status = "error";
        rec.error = err.message;
      }
      renderIntakeBody();
    }
    void todo;
    await intakeBuildPlan();
  }

  /* What is present, what each destination needs, and — for the destinations that
     can go — what would actually change. */
  async function intakeBuildPlan() {
    const parsed = intake.files.filter(r => r.status === "parsed");
    const re2 = parsed.find(r => r.kind === "re2");
    // …Rec suffixes are the dropped FILES; the unsuffixed names inside each
    // destination block are that file's parsed result. Confusing the two is how
    // you end up publishing a file object.
    const contactsRec = parsed.find(r => r.kind === "contacts");
    const startsBy = {};
    for (const r of parsed) if (r.kind === "starts" && r.division) startsBy[r.division] = r;

    const present = {
      re2: !!re2,
      contacts: !!contactsRec,
      flow: parsed.some(r => r.kind === "flow"),
      starts: Object.fromEntries(Object.keys(startsBy).map(k => [k, true]))
    };

    const targets = BPI.planTargets(present);

    for (const t of targets) {
      if (!t.ready) continue;
      const startsRec = startsBy[t.division];

      if (t.target === "vendorPortal") {
        const code = BPI.divisionByKey(t.division).code;
        const cur = await DB.vendorCurrent(t.division);
        t.currentPayload = cur.ok ? cur.payload : null;
        t.currentError = cur.ok ? null : cur.error;

        t.payload = BPI.buildVendorPayload(
          t.division, re2.parsed.re2.byCode[code], startsRec.parsed.vp, t.currentPayload);
        t.diff = t.currentPayload ? BPI.diffPayload(t.currentPayload, t.payload) : null;
        t.guard = BPI.guardVendorPayload(
          t.payload, t.currentPayload, t.payload._diag, code, re2.parsed.re2.counts);
        t.sheetNote = BPI.sheetDisagreement(
          startsRec.parsed.vp.sheet, startsRec.parsed.tf.sheet, startsRec.parsed.vp.via);
      }

      if (t.target === "takeoffFlow") {
        const ex = await DB.flowExisting(t.division);
        t.currentError = ex.ok ? null : ex.error;
        t.plan = BPI.planFlowImport(startsRec.parsed.tf.rows, ex.rows);
        t.entry = BPI.flowChangeEntry(t.plan, t.division, "Starts Log");
        t.guard = { blocking: [], warnings: [], notes: [] };
        const lastN = (t.plan.lastUpdates || []).length;
        if (!t.plan.fresh.length && !t.plan.updates.length && !lastN) {
          t.guard.notes.push("Nothing new in this log — every combination is already in the grid.");
        } else if (!t.plan.fresh.length && !t.plan.updates.length) {
          t.guard.notes.push("No new rows or trench moves — publishing refreshes each plan's latest start date, which drives the red status on the Takeoff Flow Plans tab.");
        }
      }

      if (t.target === "communityMap") {
        /* The map is a merge, not a replacement: coordinates, utilities,
           municipality and plans exist only in the published document and nothing
           in any workbook can supply them. So the current document is an input,
           not just something to diff against — publishing without it would erase
           every one of those fields.

           The same map-core.js the map's own CLI uses does the work, so a publish
           from here and a publish from the command line produce the same document.
           A drift test keeps the two copies identical. */
        const cur = await DB.mapCurrent(t.division);
        t.currentError = cur.ok ? null : cur.error;
        if (!cur.ok) continue;

        /* First publish for a division bootstraps its document from empty: the
           merge then simply adds everything the workbooks describe. map-core's
           growth guard keys off the EXISTING count and never fires on zero, so
           the bootstrap needs no special exemption. Communities arrive without
           coordinates and stay off the public map until placed — same as any
           new community. */
        t.bootstrap = !(cur.row && cur.row.payload);
        const baseDoc = t.bootstrap
          ? { generatedAt: null, updateCadenceDays: 7, dataStart: MAPCORE.currentDataStart(),
              tradeCats: [], vendors: [], communities: [] }
          : cur.row.payload;
        const basePeople = (cur.row && cur.row.people) || { people: {} };

        const divRe2 = (re2.parsed.mapRe2ByDiv && re2.parsed.mapRe2ByDiv[t.division])
                    || (t.division === "orlando" ? re2.parsed.mapRe2 : null);

        const find = { notes: [], problems: [] };
        const dataStart = MAPCORE.currentDataStart();
        const startsAgg = startsRec.parsed.mapStarts
          ? MAPCORE.aggregateStarts(startsRec.parsed.mapStarts.records, dataStart, find)
          : null;
        const idName = (startsRec.parsed.mapStarts || {}).idName || {};

        // Carry the worker's findings across so nothing it noticed is lost.
        for (const src of [startsRec.parsed.mapStarts, divRe2]) {
          if (!src) continue;
          find.notes.push(...(src.notes || []));
          find.problems.push(...(src.problems || []));
        }
        if (t.bootstrap) find.notes.push("First publish for " + t.divisionLabel
          + " — the map document is being created from this drop.");

        /* Contacts are matched by NAME against the communities that will exist
           after this run, so this has to happen here rather than in the worker —
           it needs the published document. The sheet is ~50 rows, so the cost is
           nothing. */
        let contacts = null;
        if (contactsRec) {
          const names = new Set((baseDoc.communities || []).map(c => c.name));
          if (startsAgg) for (const id of startsAgg.keys()) names.add(idName[id] || id);
          try {
            contacts = MAPCORE.parseContacts(contactsRec.parsed.rows, [...names], find);
          } catch (err) {
            // A malformed sheet is an expected failure, not a crash: the other
            // destinations must still be publishable.
            find.problems.push("contact sheet: " + err.message);
          }
        }

        t.mapResult = MAPCORE.buildDocument({
          data: baseDoc,
          people: basePeople,
          startsAgg, idName,
          re2: divRe2 || null,
          contacts, dataStart,
          notes: find.notes, problems: find.problems
        });

        /* Kept so a coordinate entered below can be re-diffed against the same
           baseline. Recomputing the diff after a placement is the difference
           between the card saying "3 awaiting a location" and it still saying 3
           after you have just placed one. */
        t.currentPayload = baseDoc;

        t.diff = MAPCORE.diffDocument(baseDoc, t.mapResult.next);

        /* Which communities are still off the map, and what there is to go on for
           each: the streets the permit log gave us, anything a previous run
           tried, and any proposal waiting to be confirmed. Rendered on the card
           so the operator can place them before publishing rather than
           discovering afterwards that the starts went nowhere. */
        t.streets = (startsRec.parsed.mapStarts || {}).streets || {};
        t.pending = MAPCORE.pendingLocations(t.mapResult.next, t.streets);

        /* Community-DB knows where these are supposed to be. Fetched only when
           something is actually waiting — it is a whole extra query, and on a
           normal week nothing is. Never fatal: a failure here costs context on a
           screen, not the import. */
        if (t.pending.length) {
          const loc = await DB.mapLocalities(t.division);
          t.localityError = loc.ok ? null : loc.error;
          attachLocalities(t.pending, loc.by);
        }

        t.guard = {
          blocking: t.mapResult.problems,
          warnings: [],
          notes: t.mapResult.notes
        };
        if (!contactsRec) {
          t.guard.warnings.push("No contacts export, so construction managers are "
            + "left exactly as they are. Everything else still updates.");
        }
        /* Deliberately NOT pushed onto guard.warnings. Placing a community from
           this card changes the count, and a warning computed once at plan time
           would go on announcing three long after you had placed one — which is
           how a card teaches you to stop reading it. The list itself carries the
           count, and is rebuilt on every render. */
      }
    }

    intake.targets = targets;
    intake.present = present;
    renderIntakeBody();
  }

  /* ------------------------------------------------------------- intake UI */

  function fmtBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  async function renderIntake(v, stale) {
    stale = stale || (() => false);
    v.innerHTML =
      '<div class="panel"><div class="panel-h">Data Intake</div>' +
      '<div class="panel-b"><p class="hint" style="margin:0">Checking what you can publish…</p></div></div>';

    if (!intake.roles) {
      intake.roles = await DB.intakeRoles(state.email);
    }
    if (stale()) return;

    v.innerHTML =
      '<div class="panel">' +
        '<div class="panel-h">Data Intake</div>' +
        '<div class="panel-b">' +
          '<p class="hint" style="margin:0 0 10px">' +
            "Drop the workbooks as they arrive — the Starts Log from each division's permitting " +
            "manager, the RE2 export from E1, the contacts export from Power BI. Each file is " +
            "recognised on its own, and each destination publishes only once everything it needs " +
            "is here. Nothing is written until you press a Publish button." +
          "</p>" +
          '<div id="intakeDrop" class="uptile" tabindex="0" role="button" ' +
               'aria-label="Add workbooks">' +
            '<div class="uptile-ic">&#8595;</div>' +
            '<div class="uptile-t">Drop workbooks here, or click to browse</div>' +
            '<div class="uptile-s">.xlsx and .xlsm — several at once is fine</div>' +
          "</div>" +
          '<input type="file" id="intakeInput" accept=".xlsx,.xlsm" multiple class="hidden">' +
        "</div>" +
      "</div>" +
      '<div id="intakeBody"></div>';

    const drop = $("intakeDrop"), input = $("intakeInput");
    const open = () => input.click();
    drop.onclick = open;
    drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    ["dragenter", "dragover"].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "dragend", "drop"].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", e => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        intakeAddFiles(e.dataTransfer.files);
      }
    });
    input.onchange = () => { if (input.files.length) intakeAddFiles(input.files); input.value = ""; };

    renderIntakeBody();
  }

  function renderIntakeProgress(rec) {
    const el = document.getElementById("prog-" + rec.id);
    if (el && rec.progress) {
      el.style.width = rec.progress.pct + "%";
      const lbl = document.getElementById("proglbl-" + rec.id);
      if (lbl) lbl.textContent = rec.progress.stage + "…";
    }
  }

  function renderIntakeBody() {
    const body = $("intakeBody");
    if (!body) return;
    body.innerHTML = intakeFilesHtml() + intakeTargetsHtml();
    body.querySelectorAll("[data-remove]").forEach(b => {
      b.onclick = () => {
        intake.files = intake.files.filter(f => f.id !== b.dataset.remove);
        intakeBuildPlan();
      };
    });
    body.querySelectorAll("[data-setdiv]").forEach(sel => {
      sel.onchange = async () => {
        const rec = intake.files.find(f => f.id === sel.dataset.setdiv);
        if (!rec) return;
        rec.division = sel.value || null;
        rec.status = rec.division ? "ready" : "needs-division";
        rec.parsed = null;
        await intakeParseAll();
      };
    });
    body.querySelectorAll("[data-publish]").forEach(b => {
      b.onclick = () => intakePublish(b.dataset.publish, b.dataset.division);
    });
    const clear = document.getElementById("intakeClear");
    if (clear) clear.onclick = () => { intakeReset(); renderIntakeBody(); };
    const all = document.getElementById("intakePublishAll");
    if (all) all.onclick = () => intakePublishAll();

    /* Locating edits the document this card is about to publish — in memory,
       nothing written — so the counts, the diff and the pending list all have to
       be recomputed against it afterwards. Re-rendering the whole body is the
       cheap and honest way: it guarantees what you see is the document as it now
       stands, rather than a card that still says three when you have just placed
       one of them. */
    const mapT = (intake.targets || []).find(t => t.target === "communityMap" && t.mapResult);
    if (mapT) {
      bindLocate(body, "ilo",
        num => (mapT.mapResult.next.communities || []).find(c => c.num === num),
        async (num, what) => {
          mapT.locatedHere = (mapT.locatedHere || 0) + 1;
          mapT.diff = MAPCORE.diffDocument(mapT.currentPayload, mapT.mapResult.next);
          mapT.pending = MAPCORE.pendingLocations(mapT.mapResult.next, mapT.streets || {});
          toast(what.kind === "rejected"
            ? what.name + " left unplaced — that point will not be offered again"
            : what.name + " placed at " + what.lat + ", " + what.lon +
              " — publish to save it", what.kind === "rejected" ? "" : "ok");
          renderIntakeBody();
        },
        state.email, mapT.pending);
    }
  }

  function intakeFilesHtml() {
    if (!intake.files.length) return "";
    const rows = intake.files.map(f => {
      const kind = INTAKE_KINDS[f.kind] || INTAKE_KINDS.unknown;
      let statusCell;
      if (f.status === "identifying") statusCell = '<span class="hint">Identifying…</span>';
      else if (f.status === "parsing") {
        statusCell =
          '<div class="prog"><div class="prog-bar" id="prog-' + f.id + '" style="width:' +
          ((f.progress && f.progress.pct) || 0) + '%"></div></div>' +
          '<span class="hint" id="proglbl-' + f.id + '">' +
          esc((f.progress && f.progress.stage) || "reading") + "…</span>";
      } else if (f.status === "error") {
        statusCell = '<span class="pill bad">Could not read</span> <span class="hint">' + esc(f.error) + "</span>";
      } else if (f.status === "unrecognised") {
        // Naming what it looked for beats "unrecognised file", which leaves the
        // reader with nothing to check.
        statusCell = '<span class="pill warn">Not recognised</span> <span class="hint">' +
          esc(f.why || "") + ". Expected a Starts Log, the RE2 export, the contacts export, " +
          "or the Flow of Takeoffs workbook.</span>";
      } else if (f.status === "needs-division") {
        statusCell = '<span class="pill warn">Which division?</span>';
      } else if (f.status === "parsed") {
        statusCell = '<span class="pill ok">Read</span> <span class="hint">' + esc(intakeFileSummary(f)) + "</span>";
      } else {
        statusCell = '<span class="hint">Queued</span>';
      }

      const divCell = (f.kind === "starts")
        ? '<select data-setdiv="' + f.id + '">' +
            '<option value=""' + (f.division ? "" : " selected") + ">Choose…</option>" +
            BPI.DIVISIONS.map(d => '<option value="' + d.key + '"' +
              (f.division === d.key ? " selected" : "") + ">" + esc(d.label) + "</option>").join("") +
          "</select>"
        : "<span class=\"hint\">—</span>";

      return "<tr>" +
        "<td><b>" + esc(f.name) + "</b><br><span class=\"hint\">" + fmtBytes(f.size) + "</span></td>" +
        "<td>" + esc(kind.label) + "</td>" +
        "<td>" + divCell + "</td>" +
        "<td>" + statusCell + "</td>" +
        '<td><button class="linkbtn" data-remove="' + f.id + '">Remove</button></td>' +
        "</tr>";
    }).join("");

    return '<div class="panel"><div class="panel-h">Files ' +
      '<button class="linkbtn" id="intakeClear" style="float:right">Clear all</button></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      "<th>File</th><th>Recognised as</th><th>Division</th><th>Status</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function intakeFileSummary(f) {
    const p = f.parsed || {};
    if (f.kind === "re2" && p.re2) {
      return p.re2.total.toLocaleString() + " rows · " +
        Object.entries(p.re2.counts).map(([c, n]) => n.toLocaleString() + " " + c).join(", ");
    }
    if (f.kind === "starts" && p.vp) {
      return 'sheet "' + p.vp.sheet + '" · ' + p.vp.sourceRows.toLocaleString() + " rows · " +
        p.vp.startRecords.length.toLocaleString() + " start records · " +
        p.tf.rows.length.toLocaleString() + " plan/elevation combinations";
    }
    if (f.kind === "contacts" && p.rows) return p.rows.length + " rows";
    if (f.kind === "flow" && p.flowRowsRaw) return p.flowRowsRaw.length + " rows";
    return "";
  }

  function intakeTargetsHtml() {
    if (!intake.targets || !intake.targets.length) return "";
    const cards = intake.targets.map(t => intakeTargetCard(t)).join("");
    const ready = intakePublishable();
    const waiting = intake.targets.filter(t => !t.ready).length;

    /* The bar above the cards. It exists because the whole point of this screen is
       that one upload feeds several apps, and making you press four buttons in the
       right order buries that. What it must not do is hide what it is about to
       write — hence the count, and the per-destination confirmation list. */
    let bar;
    if (intake.batch) {
      bar = '<div class="intake-bar"><span class="hint">Publishing ' +
        (intake.batch.done + 1) + " of " + intake.batch.total + " — " +
        esc(intake.batch.current) + "…</span>" +
        '<div class="prog" style="width:180px"><div class="prog-bar" style="width:' +
        Math.round((intake.batch.done / intake.batch.total) * 100) + '%"></div></div></div>';
    } else if (ready.length > 1) {
      bar = '<div class="intake-bar">' +
        "<span><b>" + ready.length + "</b> destinations ready" +
        (waiting ? ', <span class="hint">' + waiting + " still waiting on files</span>" : "") +
        "</span>" +
        '<button class="btn" id="intakePublishAll"' + (intake.busy ? " disabled" : "") +
        ">Publish all " + ready.length + "</button></div>";
    } else if (ready.length === 1) {
      bar = '<div class="intake-bar"><span class="hint">One destination ready' +
        (waiting ? ", " + waiting + " still waiting on files" : "") +
        " — publish it from its card below.</span></div>";
    } else {
      bar = "";
    }

    return '<div class="panel"><div class="panel-h">Destinations</div>' +
      '<div class="panel-b" style="display:grid;gap:12px">' + bar + cards + "</div></div>";
  }

  function intakeTargetCard(t) {
    const title = esc(t.label) + " — " + esc(t.divisionLabel);
    const result = intake.results[t.target + ":" + t.division];

    if (result) {
      return '<div class="intake-card ' + (result.ok ? "ok" : "bad") + '">' +
        "<h4>" + title + "</h4><p>" + esc(result.message) + "</p>" +
        (result.historyError
          ? '<p class="hint">Published, but the history entry failed: ' + esc(result.historyError) +
            ". The data is live; What's New will not show this import.</p>"
          : "") +
        "</div>";
    }

    if (!t.ready) {
      return '<div class="intake-card waiting"><h4>' + title + "</h4>" +
        '<p class="hint">Waiting for ' + t.missing.map(esc).join(" and ") + ".</p></div>";
    }

    const roleKey = t.target === "takeoffFlow" ? "takeoffFlow"
                  : t.target === "communityMap" ? "map" : "vendorPortal";
    const mayPublish = DB.canPublish(intake.roles && intake.roles[roleKey], t.division);

    if (t.currentError) {
      return '<div class="intake-card bad"><h4>' + title + "</h4>" +
        '<p>Could not read what is currently published: ' + esc(t.currentError) + "</p>" +
        '<p class="hint">Nothing can be previewed or published until that succeeds — publishing ' +
        "blind would overwrite data without knowing what it replaces.</p></div>";
    }

    const g = t.guard || { blocking: [], warnings: [], notes: [] };
    const blocked = g.blocking.length > 0;

    let stats = "", detail = "";
    if (t.target === "vendorPortal") {
      const assign = t.payload.vendors.reduce((s, v) => s + v.assigned.length, 0);
      stats = intakeKpis([
        [t.payload.communities.length, "Communities"],
        [new Set(t.payload.vendors.map(v => v.name)).size, "Trade partners"],
        [t.payload.categories.length, "Categories"],
        [assign, "Assignments"]
      ]);
      detail = t.diff
        ? '<p class="hint">Against what is published now: ' +
            "+" + t.diff.commsAdded + " / −" + t.diff.commsRemoved + " communities, " +
            "+" + t.diff.assignmentsAdded + " / −" + t.diff.assignmentsRemoved + " assignments, " +
            "+" + t.diff.vendorsAdded + " / −" + t.diff.vendorsRemoved + " vendors.</p>"
        : '<p class="hint">Nothing is published for this division yet, so there is nothing to compare against.</p>';
      detail += '<p class="hint">Publishing replaces the whole division. The version it replaces ' +
                "is kept, so it can be rolled back from Vendor Assignments.</p>";
    } else if (t.target === "takeoffFlow") {
      stats = intakeKpis([
        [t.plan.fresh.length, "New rows"],
        [t.plan.updates.length, "Trench updates"],
        [(t.plan.lastUpdates || []).length, "Latest-start refreshes"],
        [t.plan.newCommunities.length, "New communities"],
        [t.plan.parsed, "Parsed"]
      ]);
      detail = '<p class="hint">Existing rows keep their manual edits — only a First Trench date ' +
               "that moved earlier is changed. Latest-start dates are refreshed from this log; " +
               "a plan with no start from today forward shows red on the Takeoff Flow Plans tab.</p>";
      if (t.plan.newCommunities.length) {
        detail += '<p class="hint">New: ' +
          t.plan.newCommunities.slice(0, 8).map(esc).join(", ") +
          (t.plan.newCommunities.length > 8 ? " and " + (t.plan.newCommunities.length - 8) + " more" : "") +
          ".</p>";
      }
    } else if (t.target === "communityMap") {
      const r = t.mapResult;
      const plotted = r.next.communities.filter(
        c => Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0)).length;
      stats = intakeKpis([
        [r.totals.communities, "Communities"],
        [plotted, "On the map"],
        [r.totals.starts, "Starts in window"],
        [r.added.length, "New"]
      ]);
      detail = '<p class="hint">A merge, not a replacement: coordinates, utilities, municipality ' +
               "and plans exist only in the published document and are carried across untouched. " +
               "An import never removes a community.</p>";
      if (t.diff) {
        detail += '<p class="hint">Against what is published now: +' + t.diff.commsAdded +
          " / −" + t.diff.commsRemoved + " communities, starts " +
          t.diff.startsBefore.toLocaleString() + " → " + t.diff.startsAfter.toLocaleString() + ".</p>";
      }
      if (r.dormant.length) {
        detail += '<p class="hint">' + r.dormant.length + " with no starts in this window, kept: " +
          r.dormant.slice(0, 6).map(esc).join(", ") +
          (r.dormant.length > 6 ? " and " + (r.dormant.length - 6) + " more" : "") + ".</p>";
      }
      const cov = r.coverage;
      if (cov && cov.unmatched.length) {
        detail += '<p class="hint">' + cov.unmatched.length + " contact-sheet entr" +
          (cov.unmatched.length === 1 ? "y" : "ies") + " matched no community: " +
          cov.unmatched.map(esc).join(", ") +
          ". Add an alias in map-core.js, or ignore if not on the map yet.</p>";
      }
      if (cov && cov.nowStaffed.length) {
        detail += '<p class="hint">Gained contacts: ' + cov.nowStaffed.map(esc).join(", ") +
          " — remove from AWAITING_CONTACTS in map-core.js.</p>";
      }

      /* Placing one here edits the document about to be published, so it goes out
         with the same Publish button and the same rollback copy. Nothing is
         written until that is pressed. */
      detail += locateListHtml(t.pending || [], "ilo", mayPublish,
        "Placed here, they go out with this publish. Most communities resolve on " +
        "their own from the permit log's street names — run " +
        "<code>tools/locate-communities.js</code> in the map repo for that. What is " +
        "left needs a person.", true);
    }

    const notes = (t.sheetNote ? [t.sheetNote] : []).concat(
      g.notes.map(n => ({ level: "note", text: n })),
      g.warnings.map(n => ({ level: "warn", text: n })),
      g.blocking.map(n => ({ level: "bad", text: n }))
    );
    const noteHtml = notes.length
      ? '<ul class="intake-notes">' + notes.map(n =>
          '<li class="' + n.level + '">' + esc(n.text) + "</li>").join("") + "</ul>"
      : "";

    let button;
    if (!mayPublish) {
      button = '<p class="hint">You do not have publish rights for ' + esc(t.divisionLabel) +
               " in " + esc(t.label) + ", so this one is read-only for you.</p>";
    } else if (blocked) {
      button = '<p class="hint">Publishing is blocked until the problems above are resolved.</p>';
    } else if (intakeNothingToDo(t)) {
      button = '<p class="hint">Nothing to publish.</p>';
    } else {
      button = '<button class="btn" data-publish="' + t.target + '" data-division="' + t.division + '"' +
               (intake.busy ? " disabled" : "") + ">Publish to " + esc(t.label) + "</button>";
    }

    return '<div class="intake-card' + (blocked ? " bad" : "") + '">' +
      "<h4>" + title + "</h4>" + stats + detail + noteHtml + button + "</div>";
  }

  /* Would publishing this change anything? Re-dropping the same workbook is a
     normal thing to do — you lose track of whether you already published — and it
     should read as "nothing to publish" rather than offering a button that writes
     an empty history entry. */
  function intakeNothingToDo(t) {
    if (t.target === "takeoffFlow") return !t.plan.fresh.length && !t.plan.updates.length && !(t.plan.lastUpdates || []).length;
    if (t.target === "communityMap") {
      /* A coordinate placed on this card is a change the diff cannot see — it
         counts communities and starts, and a placement moves neither. Without
         this, re-dropping last week's log and then placing a community would
         hide the Publish button and quietly discard the one thing you came here
         to do. */
      if (t.locatedHere) return false;
      const d = t.diff;
      return !!d && !d.commsAdded && !d.commsRemoved && d.startsBefore === d.startsAfter;
    }
    return false;   // Vendor Assignments replaces the payload wholesale every time
  }

  // Which destinations a Publish all would actually write to, in a stable order.
  function intakePublishable() {
    const roleFor = t => t.target === "takeoffFlow" ? "takeoffFlow"
                       : t.target === "communityMap" ? "map" : "vendorPortal";
    return (intake.targets || []).filter(t =>
      t.ready &&
      !t.currentError &&
      !intake.results[t.target + ":" + t.division] &&
      !(t.guard && t.guard.blocking.length) &&
      !intakeNothingToDo(t) &&
      DB.canPublish(intake.roles && intake.roles[roleFor(t)], t.division));
  }

  function intakeKpis(pairs) {
    return '<div class="kpis">' + pairs.map(([n, l]) =>
      '<div class="kpi"><div class="n">' + Number(n).toLocaleString() + '</div>' +
      '<div class="l">' + esc(l) + "</div></div>").join("") + "</div>";
  }

  // One line per destination, used in both confirmation dialogs.
  function intakeSummaryLine(t) {
    if (t.target === "vendorPortal") {
      return t.diff
        ? "replace the division — communities +" + t.diff.commsAdded + " / −" + t.diff.commsRemoved +
          ", assignments +" + t.diff.assignmentsAdded + " / −" + t.diff.assignmentsRemoved
        : "first publish for this division";
    }
    if (t.target === "takeoffFlow") {
      return "add " + t.plan.fresh.length + " row(s), update " + t.plan.updates.length + " trench date(s)" +
             ", refresh " + (t.plan.lastUpdates || []).length + " latest-start date(s)";
    }
    if (t.target === "communityMap") {
      return "merge — " + t.mapResult.totals.communities + " communities, +" +
             t.diff.commsAdded + " new, starts " + t.diff.startsBefore.toLocaleString() +
             " → " + t.diff.startsAfter.toLocaleString();
    }
    return "publish";
  }

  /* Write one destination. Returns the result rather than rendering, so the
     single-button path and Publish all share exactly the same writes — the batch
     is not a second implementation that could drift from the individual one. */
  async function intakeWriteOne(t) {
    const key = t.target + ":" + t.division;

    if (t.target === "vendorPortal") {
      const summary = t.diff || BPI.diffPayload(null, t.payload);
      const res = await DB.vendorPublish(t.division, t.payload, summary, state.email);
      intake.results[key] = res.ok
        ? { ok: true, message: t.divisionLabel + " replaced — " +
              t.payload.communities.length.toLocaleString() + " communities, " +
              t.payload.vendors.length.toLocaleString() + " vendor records.",
            historyError: res.historyWritten ? null : res.historyError }
        : { ok: false, message: "Publish failed: " + res.error };

    } else if (t.target === "takeoffFlow") {
      const res = await DB.flowPublish(t.division, t.plan.fresh, t.plan.updates,
                                       t.plan.lastUpdates || [], t.entry, state.email);
      intake.results[key] = res.ok
        ? { ok: true, message: "Added " + res.added + " row(s), updated " + res.updated +
              " trench date(s) and refreshed " + (res.refreshed || 0) +
              " latest-start date(s) in " + t.divisionLabel + ".",
            historyError: res.historyWritten ? null : res.historyError }
        : { ok: false, message: "Publish failed: " + res.error };

    } else if (t.target === "communityMap") {
      const r = t.mapResult;
      const res = await DB.mapPublish(t.division, t.divisionLabel, r.next, r.people,
                                      t.diff, state.email);
      const held = r.next.communities.filter(
        c => !Number.isFinite(c.lat) || !Number.isFinite(c.lon)).length;
      intake.results[key] = res.ok
        ? { ok: true, message: "Map updated — " + r.totals.communities + " communities, " +
              r.totals.starts.toLocaleString() + " starts" +
              (held ? ". " + held + " held off the map until located." : "."),
            historyError: res.historyWritten ? null : res.historyError }
        : { ok: false, message: "Publish failed: " + res.error };
    }

    return intake.results[key];
  }

  async function intakePublish(target, division) {
    const t = (intake.targets || []).find(x => x.target === target && x.division === division);
    if (!t || intake.busy) return;

    const head = t.target === "vendorPortal"
      ? "Replace all " + t.divisionLabel + " data in Vendor Assignments?"
      : t.target === "takeoffFlow"
        ? "Update Takeoff Flow " + t.divisionLabel + "?"
        : "Update the Community Map?";

    const tail = t.target === "vendorPortal"
      ? "The version being replaced is kept, so this can be rolled back."
      : t.target === "communityMap"
        ? "A merge — nothing is removed, and coordinates and utilities are preserved."
        : "New rows are added; existing rows keep their manual edits.";

    const okGo = await confirmBox("Publish",
      "<p>" + esc(head) + "</p><p>" + esc(intakeSummaryLine(t)) + "</p>" +
      '<p class="hint">' + esc(tail) + "</p>", "Publish", false);
    if (!okGo) return;

    intake.busy = true;
    renderIntakeBody();
    const res = await intakeWriteOne(t);
    intake.busy = false;
    toast(res.ok ? "Published." : "Publish failed.", res.ok ? "ok" : "err");
    renderIntakeBody();
  }

  /* Publish all.

     Sequential, not parallel. Three reasons, in order of how much they matter:
     a failure is attributable to one destination rather than to "the batch"; a
     later destination can be skipped once an earlier one fails, if you choose to
     stop; and four concurrent writes of a multi-megabyte payload is not kind to
     anything in the path.

     It does NOT roll back on failure, and says so before you start. No transaction
     spans three applications, so a batch that claimed to be atomic would be lying.
     What it does instead is report exactly which ones landed. */
  async function intakePublishAll() {
    if (intake.busy) return;
    const list = intakePublishable();
    if (!list.length) return;

    const rows = list.map(t =>
      "<li><b>" + esc(t.label) + " — " + esc(t.divisionLabel) + "</b><br>" +
      '<span class="hint">' + esc(intakeSummaryLine(t)) + "</span></li>").join("");

    const okGo = await confirmBox("Publish to " + list.length + " destinations",
      "<p>These will be published one after another:</p>" +
      '<ul class="intake-notes">' + rows + "</ul>" +
      '<p class="hint">They are written independently. If one fails the others are ' +
      "not undone — there is no transaction across separate applications — and the " +
      "results below will show which succeeded.</p>",
      "Publish all", false);
    if (!okGo) return;

    intake.busy = true;
    for (let i = 0; i < list.length; i++) {
      intake.batch = { done: i, total: list.length, current: list[i].label + " — " + list[i].divisionLabel };
      renderIntakeBody();
      await intakeWriteOne(list[i]);
    }
    intake.batch = null;
    intake.busy = false;

    const done = list.filter(t => (intake.results[t.target + ":" + t.division] || {}).ok).length;
    toast(done === list.length
      ? "Published to " + done + " destinations."
      : done + " of " + list.length + " published — check the cards.",
      done === list.length ? "ok" : "err");
    renderIntakeBody();
  }

  /* ------------------------------------------------------- LOCATING A COMMUNITY

     A community arrives from the permit log with no coordinate, and until it has
     one it is absent from the map, from its counts and from its exports — and so
     are its starts. Placing it is therefore not housekeeping; it is the
     difference between a hundred scheduled starts being visible and not.

     Everything that DECIDES anything lives in map-core.js and is unit-tested
     without a browser. This is the surface: it renders what map-core already
     worked out and hands back what the operator said.

     ── WHY THERE IS NO "LOCATE THEM ALL" BUTTON HERE ─────────────────────────
     Resolving a street name needs Nominatim, which requires a User-Agent
     identifying the caller. A browser cannot set that header — it is forbidden —
     so a browser cannot use the service on the terms it asks for, whatever CORS
     permits. Street resolution therefore runs from the map repo's
     tools/locate-communities.js, which can meet both obligations, and most
     communities are placed there without anyone doing anything.

     What lands HERE is the remainder: the ones that need a person. A proposal to
     confirm or refuse, a coordinate to type, an address to look up. Census
     answers address lookups and asks for no header, so that one does work from a
     browser — assuming it permits cross-origin requests, which is unverified. If
     it does not, the message says so and the coordinate box still works.

     ── TWO HOSTS, ONE RENDERER ───────────────────────────────────────────────
     Data Intake edits a document that has not been published yet; Health edits
     the published one directly. Same rows, same controls, same rules — only the
     write differs, which is the `onChange` handler. A second implementation is
     how the two would come to disagree about what "placed" means.               */

  /* Hang each community's CIS locality on its pending row. Kept separate from
     pendingLocations() because map-core is network-free and this comes from a
     different table in a different app — the two are joined here, at the point
     where both are in hand. */
  function attachLocalities(pending, by) {
    for (const p of pending || []) p.locality = (by || {})[p.num] || null;
    return pending;
  }

  // "DeBary, FL 32713" out of a parsed locality, for showing and for appending
  // to a street somebody types into the address box.
  function localityLine(loc) {
    if (!loc) return "";
    const place = loc.city || (loc.county ? loc.county + " County" : null);
    /* "DeBary, FL 32713" — state and postcode separated by a SPACE, which is how
       an address is written and how a geocoder expects to read one. Joining all
       three with commas gives "DeBary, FL, 32713", which looks close enough to
       be missed in review and parses worse. */
    const tail = [loc.state, loc.zip].filter(Boolean).join(" ");
    return [place, tail].filter(Boolean).join(", ");
  }

  /* One pending community. `ns` namespaces the data attributes so two hosts on
     one page cannot bind each other's buttons. */
  function locateRowHtml(p, ns, canEdit, haveStreets) {
    const id = ns + "-" + p.num;
    const hidden = p.startsHidden
      ? '<span class="pill warn">' + p.startsHidden.toLocaleString() +
        " start" + (p.startsHidden === 1 ? "" : "s") + " hidden</span>"
      : '<span class="pill">no starts scheduled</span>';

    let evidence = "";
    if (p.streets && p.streets.length) {
      /* The streets are the evidence the CLI works from, and showing them is what
         makes "still pending" legible: a community with four streets is waiting
         on the geocoder, one with none is waiting on the permit log. */
      const shown = p.streets.slice(0, 6).map(s =>
        esc(s.street) + ' <span class="hint" style="display:inline">(' + s.lots + ")</span>").join(", ");
      evidence = '<p class="hint">Streets in the permit log: ' + shown +
        (p.streets.length > 6 ? " and " + (p.streets.length - 6) + " more" : "") + ".</p>";
    } else if (haveStreets) {
      /* Only sayable when a permit log was actually read. Saying it on the Health
         route — where no workbook has been dropped and NO community has streets —
         would be reporting a fact about the data that is really a fact about the
         screen you are on. */
      evidence = '<p class="hint">No street names in the permit log for this one — its ' +
        "whole address column is blank or reads TBD, so nothing can be looked up. " +
        "It needs a coordinate typed in.</p>";
    } else {
      evidence = "";
    }

    /* Shown because it changes what the operator should do. A community with a
       CIS locality can be geocoded from its street names by the map's CLI; one
       without has nothing to narrow the search with, and typing the coordinate
       is the shorter road. */
    if (p.locality) {
      evidence += '<p class="hint">' + esc(p.locality.source || "Community-DB") +
        " puts it in <b>" + esc(localityLine(p.locality)) + "</b>.</p>";
    }

    if (p.previously && p.previously.length) {
      evidence += '<p class="hint">Last tried: ' + p.previously.slice(0, 4).map(t =>
        esc(t.street) + " → " + esc(t.result)).join("; ") + ".</p>";
    } else if (p.why) {
      evidence += '<p class="hint">' + esc(p.why) + "</p>";
    }

    /* A proposal is a question, so it is rendered as one — with the reason it is
       not being applied on its own, because "confirm this" without the reason is
       a button people press to make the row go away. */
    let proposal = "";
    if (p.proposed) {
      proposal =
        '<div class="locate-proposal">' +
          "<p><b>Proposed:</b> " + esc(String(p.proposed.lat)) + ", " + esc(String(p.proposed.lon)) +
          (p.proposed.street ? ' from "' + esc(p.proposed.street) + '"' : "") + " " +
          '<a href="https://www.openstreetmap.org/?mlat=' + encodeURIComponent(p.proposed.lat) +
          "&mlon=" + encodeURIComponent(p.proposed.lon) + '#map=15/' +
          encodeURIComponent(p.proposed.lat) + "/" + encodeURIComponent(p.proposed.lon) +
          '" target="_blank" rel="noopener">check it on a map</a></p>' +
          '<p class="hint">' + esc(p.proposed.why || "") + "</p>" +
          (canEdit
            ? '<button class="linkbtn" data-' + ns + '-accept="' + esc(p.num) + '">Confirm this</button>' +
              '<button class="linkbtn danger" data-' + ns + '-reject="' + esc(p.num) + '">Reject</button>'
            : "") +
        "</div>";
    }

    if (p.rejected && p.rejected.length) {
      proposal += '<p class="hint">' + p.rejected.length + " earlier proposal" +
        (p.rejected.length === 1 ? " was" : "s were") + " rejected and will not be " +
        "offered again on the same evidence.</p>";
    }

    const entry = canEdit
      ? '<div class="locate-entry">' +
          '<input type="text" id="' + id + '-ll" placeholder="28.6607, -81.5458" ' +
                 'aria-label="Coordinate for ' + esc(p.name) + '">' +
          '<button class="btn mini" data-' + ns + '-place="' + esc(p.num) + '">Place</button>' +
          '<input type="text" id="' + id + '-addr" placeholder="or an address to look up" ' +
                 'aria-label="Address for ' + esc(p.name) + '">' +
          '<button class="btn mini ghost" data-' + ns + '-lookup="' + esc(p.num) + '">Look up</button>' +
        "</div>" +
        '<p class="hint" id="' + id + '-msg"></p>'
      : "";

    return '<div class="locate-row" data-' + ns + '-row="' + esc(p.num) + '">' +
      "<h5>" + esc(p.name) + " " + hidden + "</h5>" +
      evidence + proposal + entry +
      "</div>";
  }

  /* `haveStreets` says whether a permit log was read at all, which changes what
     an empty street list MEANS — see locateRowHtml. */
  function locateListHtml(pending, ns, canEdit, lead, haveStreets) {
    if (!pending || !pending.length) return "";
    const hidden = pending.reduce((a, p) => a + p.startsHidden, 0);
    return '<div class="locate">' +
      "<h4>Awaiting a location — " + pending.length +
        (hidden ? ", holding back " + hidden.toLocaleString() +
                  " start" + (hidden === 1 ? "" : "s") : "") + "</h4>" +
      (lead ? '<p class="hint">' + lead + "</p>" : "") +
      pending.map(p => locateRowHtml(p, ns, canEdit, haveStreets)).join("") +
      "</div>";
  }

  /* Wire one rendered list up. `find(num)` returns the community record to write
     onto; `onChange(num, what)` is called after a successful write so the host
     can re-render, re-diff or publish. Both hosts share every rule below. */
  function bindLocate(root, ns, find, onChange, actor, pending) {
    if (!root) return;
    /* A community number reaches this selector as data — it comes off a sheet,
       not out of the code — and an id selector is the least forgiving place to
       put untrusted text: querySelector THROWS SyntaxError on a malformed one
       rather than returning null, so a stray space or a leading digit would take
       the whole binding pass down. CSS.escape makes the id match literally.
       `ns` is a namespace the two hosts pass in as a constant, so it needs no
       escaping, but it is part of the same identifier and escapes harmlessly. */
    const idOf = (num, part) => "#" + CSS.escape(ns + "-" + num + "-" + part);
    const msgOf = num => root.querySelector(idOf(num, "msg"));
    const say = (num, text, bad) => {
      const el = msgOf(num);
      if (!el) return;
      el.textContent = text;
      el.style.color = bad ? "var(--bad)" : "var(--muted)";
    };

    root.querySelectorAll("[data-" + ns + "-place]").forEach(b => {
      b.onclick = async () => {
        const num = b.getAttribute("data-" + ns + "-place");
        const box = root.querySelector(idOf(num, "ll"));
        const pt = MAPCORE.parseLatLon(box && box.value);
        if (!pt) {
          say(num, 'Could not read that as a coordinate. Try "28.6607, -81.5458".', true);
          return;
        }
        const c = find(num);
        if (!c) { say(num, "That community is no longer in this import.", true); return; }
        const r = MAPCORE.placeManually(c, pt.lat, pt.lon, { by: actor });
        if (!r.ok) { say(num, r.error, true); return; }
        await onChange(num, { kind: "placed", lat: r.lat, lon: r.lon, name: c.name });
      };
    });

    /* The address path is an ASSIST, not an action: it fills the coordinate box
       and leaves the Place button to the person. A geocoder's answer for a
       street that does not exist yet is a confident guess somewhere else, and
       the whole design of this feature is built on never applying one of those
       without a human looking at it. */
    root.querySelectorAll("[data-" + ns + "-lookup]").forEach(b => {
      b.onclick = async () => {
        const num = b.getAttribute("data-" + ns + "-lookup");
        const box = root.querySelector(idOf(num, "addr"));
        const addr = (box && box.value || "").trim();
        if (!addr) { say(num, "Type an address first — a house number and street.", true); return; }

        /* Append the CIS locality when the person only typed a street. Census
           needs a town to disambiguate, and asking them to retype what
           Community-DB already knows is how a lookup gets skipped. Left alone if
           they typed a comma — that means they gave their own. */
        const p = (pending || []).filter(x => x.num === num)[0];
        const loc = p && p.locality;
        const full = (loc && addr.indexOf(",") === -1)
          ? addr + ", " + localityLine(loc) : addr;
        b.disabled = true;
        say(num, "Looking it up…");
        try {
          const hit = await GEOCLIENT.address(full);
          if (!hit) { say(num, "The geocoder found no such address.", true); return; }
          if (hit.error) { say(num, hit.error, true); return; }
          const ll = root.querySelector(idOf(num, "ll"));
          if (ll) ll.value = hit.lat.toFixed(6) + ", " + hit.lon.toFixed(6);
          say(num, 'That resolves to "' + (hit.matchedStreet || full) + '" at ' +
                   hit.lat.toFixed(5) + ", " + hit.lon.toFixed(5) + " (" + hit.source + ", " +
                   hit.precision + " precision). Check it, then press Place.");
        } finally {
          b.disabled = false;
        }
      };
    });

    root.querySelectorAll("[data-" + ns + "-accept]").forEach(b => {
      b.onclick = async () => {
        const num = b.getAttribute("data-" + ns + "-accept");
        const c = find(num);
        if (!c) { say(num, "That community is no longer in this import.", true); return; }
        const r = MAPCORE.acceptProposal(c, { by: actor });
        if (!r.ok) { say(num, r.error, true); return; }
        await onChange(num, { kind: "confirmed", lat: r.lat, lon: r.lon, name: c.name });
      };
    });

    root.querySelectorAll("[data-" + ns + "-reject]").forEach(b => {
      b.onclick = async () => {
        const num = b.getAttribute("data-" + ns + "-reject");
        const c = find(num);
        if (!c) { say(num, "That community is no longer in this import.", true); return; }
        const okGo = await confirmBox("Reject this location?",
          "<p>" + esc(c.name) + " would not be placed, and this point will not be " +
          "offered again.</p>" +
          '<p class="hint">Two streets agreeing, or a sibling phase being placed, is ' +
          "different evidence and would still go through. Only this answer is refused.</p>",
          "Reject", true);
        if (!okGo) return;
        const r = MAPCORE.rejectProposal(c, { by: actor });
        if (!r.ok) { say(num, r.error, true); return; }
        await onChange(num, { kind: "rejected", name: c.name });
      };
    });
  }

  /* ----------------------------------------------------------------- HEALTH */

  async function renderHealth(v, stale) {
    stale = stale || (() => false);
    v.innerHTML = '<div class="panel"><div class="empty">Running checks…</div></div>';
    const H = CFG.HEALTH;
    const panels = [];
    const alerts = [];

    /* The map's write permission is the Vendor Assignments role — see
       map_can_write() in the map's SQL — so this asks the same question Data
       Intake asks, and then narrows it to admins. Cached on `intake` because it
       is the same lookup and the same answer. */
    if (!intake.roles) intake.roles = await DB.intakeRoles(state.email);
    if (stale()) return;
    const mapAdmin = !!(intake.roles && intake.roles.map && intake.roles.map.role === "admin");

    for (const app of BP.sortApps(state.apps)) {
      if (stale()) return;        // health runs many queries; bail out early
      if (!BP.isManaged(app)) {
        const up = await DB.reachable(app.url);
        if (stale()) return;
        const meta = BP.authMeta(app);
        const kind = BP.authKind(app);
        const checks = [
          row("Site reachable", up ? "yes" : "no", up ? "ok" : "bad"),
          row("Sign-in", meta.label, null, kind === "shared" ? null : "external"),
          row("Access managed in",
              kind === "entra" ? "Microsoft Entra ID"
                : kind === "none" ? "nothing to manage" : "the app itself")
        ];

        /* An app with no role table is not automatically an app Blueprint cannot
           see. The Community Map has no sign-in and no roles, but its document is
           in this database and Data Intake publishes it — so report on it rather
           than repeating "separate backend", which stopped being true. */
        let st = up ? "ok" : "bad";

        if (BP.hasVisibleData(app)) {
          const m = await DB.mapHealth("orlando");
          if (stale()) return;

          if (!m.ok) {
            checks.push(row("Data", "could not read " + app.data_table, "warn"));
            st = worse(st, "warn");
          } else if (!m.seeded) {
            checks.push(row("Data", "no document published yet", "warn",
                            "seed it before publishing from Data Intake"));
            st = worse(st, "warn");
          } else {
            const age = BP.daysSince(m.publishedAt);
            const sAge = age == null ? "warn" : BP.assess(age, H.staleUploadDays);
            const sGeo = m.unlocated ? "warn" : "ok";

            checks.push(
              row("Last published", BP.relativeDay(m.publishedAt), sAge,
                  m.publishedBy ? m.publishedBy.split("@")[0] : null),
              row("Communities on the map", String(m.plotted)),
              /* Held-back communities are the metric worth surfacing: they are
                 absent from the map, its counts and its exports, and the only
                 thing that fixes them is somebody entering an address. Reporting
                 the starts alongside is what makes it read as urgent rather than
                 tidy — three communities is a shrug, a hundred starts is not. */
              row("Awaiting a location", String(m.unlocated), sGeo,
                  m.unlocated ? m.unlocatedStarts.toLocaleString() + " starts hidden" : null),
              row("Rolling window from", m.dataStart || "—")
            );

            /* The one place in Health that WRITES, so it is gated twice.

               Health is visible to every signed-in user — that was a deliberate
               change, so people can see the state of the estate without being
               given admin. This route writes straight to the live map document
               with no preview and no second pair of eyes, which is a different
               proposition from publishing an import that has been reviewed on
               screen. So it is offered only to map administrators, not to the
               editors who can publish through Data Intake.

               The database refuses the write too — map_can_write() — so a
               tampered-with page gets an error rather than a result. This gate
               is about not offering people a button that would fail. */
            if (m.unlocated && mapAdmin) {
              checks.push(
                '<div class="hrow"><span class="hl">Place them</span>' +
                '<span class="hv"><button class="linkbtn" id="hLocate">' +
                "Enter coordinates…</button></span></div>");
            }
            st = worse(worse(st, sAge), sGeo);

            if (m.unlocated) {
              alerts.push(app.name + ": " + m.unlocated + " communit" +
                (m.unlocated === 1 ? "y is" : "ies are") + " missing coordinates, hiding " +
                m.unlocatedStarts.toLocaleString() + " starts.");
            }
            if (sAge === "bad") {
              alerts.push(app.name + " has not been published in " + age + " days.");
            }
          }
        } else {
          checks.push(row("Data", "not visible to Blueprint", null, "separate backend"));
        }

        panels.push({
          name: app.name, state: st,
          tag: kind === "none" ? "public" : "not managed here",
          checks
        });
        if (!up) alerts.push(app.name + " did not respond.");
        continue;
      }
      const p = await healthForApp(app, H, alerts, state.isAdmin);
      if (stale()) return;
      panels.push(p);
    }

    if (state.isAdmin) {
      const acct = await accountsHealth(H, alerts);
      if (stale()) return;
      panels.push(acct);
    }

    v.innerHTML =
      '<div class="toolbar"><button class="btn mini" id="hRerun">&#8635; Re-run checks</button>' +
      '<span class="count">' + new Date().toLocaleTimeString() + "</span></div>" +
      (state.isAdmin ? "" :
        '<p class="hint" style="margin:0 0 14px">Showing the checks you have visibility for. ' +
        "Some figures — drafts awaiting publish, role counts and account status — are only " +
        "readable by administrators, so they are left out rather than shown as zero.</p>") +
      (alerts.length
        ? '<div class="warnbox"><b>' + alerts.length + " item" + (alerts.length === 1 ? "" : "s") +
          " need attention</b><ul>" + alerts.map(a => "<li>" + esc(a) + "</li>").join("") + "</ul></div>"
        : '<div class="msg ok" style="display:block;margin-bottom:16px">Everything looks healthy.</div>') +
      '<div class="healthgrid">' + panels.map(p =>
        '<div class="panel"><div class="panel-h">' +
        (p.tag ? '<span class="pubtag">' + esc(p.tag) + "</span>"
               : '<span class="dot ' + p.state + '"></span>') +
        " " + esc(p.name) + "</div>" +
        '<div class="panel-b" style="padding-top:6px">' + p.checks.join("") + "</div></div>"
      ).join("") + "</div>";

    const rerun = $("hRerun");
    if (rerun) rerun.onclick = () => render();

    const loc = $("hLocate");
    if (loc) loc.onclick = () => locateFromHealth(() => render());
  }

  /* Place a community from Health, against the document that is live right now.

     Unlike Data Intake there is nothing staged here: each placement is written
     immediately, because there is no Publish button on this screen and a change
     sitting in a modal that someone closes is a change that silently did not
     happen. Every write goes through mapPublish, so it keeps the rollback copy
     and the history entry exactly as an import does.

     No street names are available on this route — they come out of the permit
     log, and no workbook has been dropped — so this offers the two things that
     work without one: confirm or refuse a proposal a CLI run already recorded,
     and type a coordinate. */
  async function locateFromHealth(afterAll) {
    /* One panel covers every division on the map; a division with no document
       yet simply is not listed. */
    const MAP_DIVS = [["orlando", "Orlando"], ["tampa", "Tampa"]];
    const divs = [];
    for (const [key, label] of MAP_DIVS) {
      const cur = await DB.mapCurrent(key);
      if (!cur.ok) { toast("Could not read the " + label + " map document: " + cur.error, "bad"); return; }
      if (!cur.row || !cur.row.payload) continue;
      /* Localities read once per division, before the panel opens. They do not
         change while it is up, and re-reading on every re-render would put a
         query behind every keystroke's worth of progress. */
      const loc = await DB.mapLocalities(key);
      divs.push({ key, label, doc: cur.row.payload, people: cur.row.people, loc, shown: [] });
    }
    if (!divs.length) { toast("No map document is published yet.", "bad"); return; }

    let touched = 0;

    const bodyHtml = () => {
      let any = false, h = "";
      divs.forEach((d, i) => {
        const pending = attachLocalities(MAPCORE.pendingLocations(d.doc, {}), d.loc.by);
        d.shown = pending;
        if (!pending.length) return;
        any = true;
        if (divs.length > 1) h += '<h4 style="margin:14px 0 6px">' + esc(d.label) + "</h4>";
        h += locateListHtml(pending, "hlo" + i, true,
          "Each one is saved the moment you place it — there is no publish step here. " +
          "Street names come from the permit log, so they are not available on this " +
          "screen; run <code>tools/locate-communities.js</code> in the map repo to " +
          "resolve them automatically." +
          (d.loc.ok ? "" : " Community-DB could not be read (" + esc(d.loc.error) +
                         "), so the towns below are missing."), false);
      });
      return any ? h : "<p>Every community on the map has a coordinate.</p>";
    };

    modal("Communities awaiting a location", bodyHtml(), (ov) => {
      const wire = () => divs.forEach((d, i) => bindLocate(ov, "hlo" + i,
        num => (d.doc.communities || []).find(c => c.num === num),
        async (num, what) => {
          const body = ov.querySelector(".modal-body");
          if (what.kind === "rejected") {
            // A rejection changes no coordinate, but it must still be persisted
            // or the next import asks the same question again.
            const res = await DB.mapPublish(d.key, d.label, d.doc, d.people,
              { rejected: [what.name], via: "health" }, state.email);
            if (!res.ok) { toast("Could not save: " + res.error, "bad"); return; }
            toast(what.name + " left unplaced — that point will not be offered again");
          } else {
            const res = await DB.mapPublish(d.key, d.label, d.doc, d.people,
              { located: [what.name], via: "health" }, state.email);
            if (!res.ok) { toast("Could not save: " + res.error, "bad"); return; }
            toast(what.name + " placed at " + what.lat + ", " + what.lon + " — saved", "ok");
          }
          touched++;
          if (body) { body.innerHTML = bodyHtml(); wire(); }
        },
        state.email, d.shown));
      wire();

      /* Re-running the checks costs a screen of queries, so it happens once when
         the panel is dismissed rather than after every placement.

         Attached as extra listeners rather than by replacing the modal's own
         close, because there are three ways out — the ×, the backdrop and Escape
         — and hooking only the one you thought of is how the counts on the page
         behind end up disagreeing with what you just did. `done` is idempotent
         for the same reason. */
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        document.removeEventListener("keydown", onEsc);
        if (touched && afterAll) afterAll();
      };
      function onEsc(e) { if (e.key === "Escape") done(); }
      ov.querySelector("[data-x]").addEventListener("click", done);
      ov.addEventListener("click", e => { if (e.target === ov) done(); });
      document.addEventListener("keydown", onEsc);
    });
  }

  function row(label, value, st, tag) {
    return '<div class="hrow"><span class="hl">' + esc(label) + '</span><span class="hv">' +
      esc(value) + "</span>" +
      (st ? '<span class="risk risk-' + st + '">' + (st === "ok" ? "ok" : st === "warn" ? "review" : "check") + "</span>" : "") +
      (tag ? '<span class="cat-tag">' + esc(tag) + "</span>" : "") + "</div>";
  }

  /* Health checks are DIVISION-AGNOSTIC by rule.
     Every metric aggregates across all divisions and none is labelled with, or
     broken down by, a division. Blueprint is a hub — per-division detail belongs
     in the app that owns it, where the division selector gives it context. A
     count here that silently covered only one division, or that mixed divisions
     under a label implying one, would be worse than no number at all.

     Each metric also has to mean what its label says. Two originally did not:
       · "Rows missing a plan name" counted flow_rows.plan_name IS NULL — but that
         column is an optional manual override, normally null because the name is
         looked up from tf_plan_names. It would have flagged most of the table as
         broken. The real signal is the missing_plans field the app itself uses.
       · "Open takeoff changes" counted every row in takeoff_changes. That table
         has no status column; it has a `complete` boolean. Completed requests were
         being reported as open. */
  /* `full` is whether the viewer can actually see the underlying rows.

     This matters more than it looks. RLS filters silently — it does not error —
     so a viewer running the same query gets a smaller result set and no
     indication of it. cdb_cis_read restricts non-editors to status='published',
     which would render "Unpublished drafts: 0" to a viewer when the real answer
     is 4. The role tables are worse: cdb_roles_read and app_roles_sel return only
     the caller's own row, so "Explicit role rows" would read 1.

     Rather than show numbers that are wrong for some readers, metrics that RLS
     can quietly truncate are simply omitted unless the viewer can see all of it.
     An absent row is honest; a confidently wrong one is not. */
  async function healthForApp(app, H, alerts, full) {
    const checks = [];
    let st = "ok";

    if (app.slug === "Vendor-Portal") {
      // Latest upload across every division, not a per-division breakdown.
      const { data } = await DB.client.from("division_data").select();
      const rows = data || [];
      const latest = rows.reduce((a, r) =>
        (!a || new Date(r.updated_at) > new Date(a.updated_at)) ? r : a, null);
      const days = latest ? BP.daysSince(latest.updated_at) : null;
      const s = days == null ? "warn" : BP.assess(days, H.staleUploadDays);
      const rollback = rows.filter(r => r.prev_payload).length;

      checks.push(row("Last data upload", days == null ? "unknown" : BP.relativeDay(latest.updated_at), s));
      if (latest && latest.updated_by) {
        checks.push(row("Last uploaded by", latest.updated_by.split("@")[0]));
      }
      if (full) {
        checks.push(row("Change-log entries", String(await DB.count("change_log") ?? "—")));
        checks.push(row("Rollback snapshots available", String(rollback),
          rollback > 0 ? "ok" : "warn"));
      }
      if (s !== "ok" && latest) {
        alerts.push(app.name + " was last updated " + BP.relativeDay(latest.updated_at) + ".");
      }
      st = worse(st, s);
    }

    if (app.slug === "Takeoff-Flow") {
      /* No total row count here. It invited comparison with the number the app
         itself shows, which is per-division and filtered, so the two never
         agreed and the tile looked wrong even when it was arithmetically right.
         A hub-level total was not telling anyone anything they could act on.

         What remains are counts of things that need attention, which are
         meaningful without a denominator. All are counted server-side: a plain
         select is capped at 1000 rows, so counting fetched rows would quietly
         under-report once the table outgrows that — and every derived figure
         with it. */
      const flagged = await DB.countExact("flow_rows",
        q => q.not("missing_plans", "is", null).neq("missing_plans", ""));
      const noTrench = await DB.countExact("flow_rows",
        q => q.is("first_trench_date", null));
      const unassigned = await DB.countExact("pending_budget_cols",
        q => q.is("assigned_email", null));
      // `complete` is nullable, so "not true" catches false and null alike.
      const open = await DB.countExact("takeoff_changes",
        q => q.not("complete", "is", true));

      const sFlag = BP.assess(flagged || 0, H.flaggedMissingPlans);
      const sTrench = BP.assess(noTrench || 0, H.missingTrenchDates);
      const sCols = BP.assess(unassigned || 0, H.unassignedBudgetCols);

      const last = await DB.newest("tf_change_log", "at");

      checks.push(row("Rows flagged missing plans", String(flagged ?? "—"), sFlag));
      checks.push(row("Rows with no trench date", String(noTrench ?? "—"), sTrench));
      checks.push(row("Open takeoff changes", String(open ?? "—")));
      checks.push(row("Budget columns with no assignee", String(unassigned ?? "—"), sCols));
      checks.push(row("Last edit", last ? BP.relativeDay(last.at) : "unknown"));

      if (sFlag !== "ok") alerts.push(app.name + " has " + flagged + " rows flagged as missing plans.");
      if (sTrench !== "ok") alerts.push(app.name + " has " + noTrench + " rows with no trench date.");
      if (sCols !== "ok") alerts.push(app.name + " has " + unassigned + " budget columns with no assignee.");
      st = worse(worse(worse(st, sFlag), sTrench), sCols);
    }

    if (app.slug === "Community-DB") {
      const { data } = await DB.client.from("cdb_cis").select();
      const all = data || [];
      const drafts = all.filter(r => r.status === "draft").length;
      const pub = all.filter(r => r.status === "published").length;
      const review = all.filter(r => r.needs_review).length;
      const inactive = all.filter(r => r.status === "published" && r.active === false).length;

      const lastPub = await DB.newest("cdb_cis_revisions", "published_at");
      const days = lastPub ? BP.daysSince(lastPub.published_at) : null;
      const sD = BP.assess(drafts, H.unpublishedDrafts);
      const sP = days == null ? "warn" : BP.assess(days, H.stalePublishDays);
      const sR = BP.assess(review, H.needsReview);

      checks.push(row("Published communities", String(pub)));
      if (full) {
        // Drafts, review flags and image counts are all hidden from non-editors
        // by RLS, so they would read 0 rather than "not visible".
        checks.push(row("Unpublished drafts", String(drafts), sD));
        checks.push(row("Flagged needs-review", String(review), sR));
        checks.push(row("Hidden from viewers", String(inactive)));
        checks.push(row("Last publish", days == null ? "unknown" : BP.relativeDay(lastPub.published_at), sP));
        checks.push(row("Images stored", String(await DB.count("cdb_images") ?? "—")));

        if (sD !== "ok") alerts.push(app.name + " has " + drafts + " unpublished drafts.");
        if (sP !== "ok" && lastPub) {
          alerts.push(app.name + " last published " + BP.relativeDay(lastPub.published_at) + ".");
        }
        st = worse(worse(worse(st, sD), sP), sR);
      }
    }

    if (full) {
      const roleRows = await DB.count(app.role_table);
      checks.push(row("Explicit role rows", String(roleRows ?? "—")));
    }
    return { name: app.name, state: st, checks };
  }

  async function accountsHealth(H, alerts) {
    const checks = [];
    let st = "ok";

    const { rows } = state.users.length
      ? { rows: state.users }
      : await DB.loadUsers(state.apps);

    const never = rows.filter(r => !r.lastSignIn).length;
    const admins = rows.filter(BP.isAdminAnywhere).length;
    const foreign = rows.filter(r => !r.email.endsWith(CFG.ALLOWED_DOMAIN)).length;
    const oneAppAdmins = rows.filter(r => BP.adminSlugs(r).length === 1).length;

    const pending = await DB.pendingInvites();
    const sP = BP.assess(pending.rows.length, H.pendingInvites);
    const sN = BP.assess(never, H.neverSignedIn);

    checks.push(row("Total accounts", String(rows.length)));
    if (!DB.LIVE) checks.push(row("Never signed in", String(never), sN));
    checks.push(row("Admins across all apps", String(admins), admins > 0 ? "ok" : "bad"));
    checks.push(row("Non-" + CFG.ALLOWED_DOMAIN + " accounts", String(foreign), foreign ? "bad" : "ok"));
    checks.push(row("Unredeemed invite links", String(pending.rows.length), sP));
    checks.push(row("Admin in exactly one app", String(oneAppAdmins)));

    if (sP !== "ok") alerts.push(pending.rows.length + " invite links are still unredeemed.");
    if (!DB.LIVE && sN !== "ok") alerts.push(never + " accounts have never signed in.");
    if (!admins) alerts.push("No admins found — check the role tables.");

    st = worse(worse(st, sP), sN);
    return { name: "Accounts & access", state: st, checks };
  }

  function worse(a, b) {
    const rank = { ok: 0, warn: 1, bad: 2 };
    return rank[b] > rank[a] ? b : a;
  }

  /* ------------------------------------------------------------------- init */

  boot().catch(e => {
    console.error(e);
    authMsg("Something went wrong starting up: " + (e.message || e), "err");
  });
})();
