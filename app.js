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
    query: "", divisions: {}, health: null
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

  const TABS = [
    { id: "apps", label: "Apps", admin: false },
    { id: "users", label: "Users", admin: true },
    { id: "health", label: "Health", admin: false }
  ];

  function renderTabs() {
    $("tabs").innerHTML = TABS
      .filter(t => !t.admin || state.isAdmin)
      .map(t => '<button class="tab' + (state.tab === t.id ? " active" : "") +
                '" data-tab="' + t.id + '">' + t.label + "</button>").join("");
    $("tabs").querySelectorAll("[data-tab]").forEach(b => {
      b.onclick = () => go(b.dataset.tab);
    });
  }

  // Gate here as well as in renderTabs(). Hiding a tab button is presentation,
  // not access control — this refuses the navigation itself, so a stale state
  // or a console call cannot land a non-admin on the people-management screen.
  // The real boundary is still server-side: the list RPCs and RLS refuse a
  // non-admin regardless of what the client renders.
  function allowed(tab) {
    const t = TABS.find(x => x.id === tab);
    if (!t) return false;
    return !t.admin || state.isAdmin;
  }

  function go(tab) {
    if (!allowed(tab)) {
      if (tab !== "apps") toast("That section is for admins only.", "err");
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
      // A configured icon that fails to load is also a missing asset, so it falls
      // back to the identical flagged placeholder rather than an unstyled gap.
      return '<img class="' + c + '" src="' + esc(app.icon_url) + '" alt="" ' +
             'onerror="this.outerHTML=\'<div class=&quot;' + phClass +
             '&quot; title=&quot;Logo failed to load&quot;>' + initials + '</div>\'">';
    }
    return '<div class="' + phClass + '" title="No logo.svg published yet">' +
           initials + "</div>";
  }

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
      "in another, and there is deliberately no control that changes all of them at once." +
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
      '<button class="btn" data-yes>' + (isNew ? "Create access" : "Save changes") + "</button></div>";

    modal(isNew ? "Add a user" : "Manage access", body, (ov, close) => {
      // enable/disable division checkboxes to match the chosen role
      managed.forEach(app => {
        const sel = ov.querySelector('[data-r="' + app.slug + '"]');
        const sync = () => {
          const scopedRole = (app.division_scoped_roles || []).indexOf(sel.value) !== -1;
          const wrap = ov.querySelector('[data-divs="' + app.slug + '"]');
          if (wrap) wrap.querySelectorAll("input").forEach(i => { i.disabled = !scopedRole; });
          ov.querySelector('[data-card="' + app.slug + '"]')
            .classList.toggle("on", sel.value !== IMPLICIT);
        };
        sel.onchange = sync;
        sync();
      });

      ov.querySelector("[data-no]").onclick = close;
      ov.querySelector("[data-yes]").onclick = () => saveAccess(ov, isNew, email, managed);
    });
  }

  function readAccess(ov, managed) {
    const grants = [], clears = [];
    for (const app of managed) {
      const role = ov.querySelector('[data-r="' + app.slug + '"]').value;
      if (role === IMPLICIT) { clears.push(app); continue; }
      const wrap = ov.querySelector('[data-divs="' + app.slug + '"]');
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

    let links = [];
    if (ov.querySelector("#acLink").checked) {
      // Everyone needs a password even with no explicit role, so fall back to
      // the shared pool when nothing scoped was granted.
      const pools = BP.poolsForGrants(plan.grants);
      const r = await DB.provision(v.email, plan.grants.length ? plan.grants
        : [{ slug: null, tokenPool: "A" }], state.adminSlugs, state.apps);
      links = r.links || [];
      void pools;
    }

    btn.disabled = false; btn.textContent = isNew ? "Create access" : "Save changes";

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

  /* ----------------------------------------------------------------- HEALTH */

  async function renderHealth(v, stale) {
    stale = stale || (() => false);
    v.innerHTML = '<div class="panel"><div class="empty">Running checks…</div></div>';
    const H = CFG.HEALTH;
    const panels = [];
    const alerts = [];

    for (const app of BP.sortApps(state.apps)) {
      if (stale()) return;        // health runs many queries; bail out early
      if (!BP.isManaged(app)) {
        const up = await DB.reachable(app.url);
        if (stale()) return;
        const meta = BP.authMeta(app);
        const kind = BP.authKind(app);
        panels.push({
          name: app.name, state: up ? "ok" : "bad",
          tag: kind === "none" ? "public" : "not managed here",
          checks: [
            row("Site reachable", up ? "yes" : "no", up ? "ok" : "bad"),
            row("Sign-in", meta.label, null, kind === "shared" ? null : "external"),
            row("Access managed in",
                kind === "entra" ? "Microsoft Entra ID"
                  : kind === "none" ? "nothing to manage" : "the app itself"),
            row("Data", "not visible to Blueprint", null, "separate backend")
          ]
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
