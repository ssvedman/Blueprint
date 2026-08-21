/* ============================================================================
   Blueprint — db.js
   Chooses the backend and exposes the handful of data operations app.js needs.

   The point of this layer: app.js never knows whether it is talking to real
   Supabase or the local mock. Both satisfy the same interface, so the local
   environment exercises the genuine code paths rather than a parallel set.
   ========================================================================== */
window.BPDB = (function () {
  "use strict";
  const CFG = window.APP_CONFIG;
  const BP = window.BP;

  const hasCreds = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
                      CFG.SUPABASE_URL.indexOf("https") === 0);

  // Localhost defaults to the mock even with real credentials present. Config
  // holds live values so the repo is deploy-ready, but that must not mean a
  // stray click while developing writes to production role tables. Opt in
  // explicitly with ?live=1 when you actually want to test against Supabase.
  const onLocalhost = typeof location !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  const forcedLive = typeof location !== "undefined" && /[?&]live=1\b/.test(location.search);

  const LIVE = hasCreds && (!onLocalhost || forcedLive);
  const FORCED_LIVE_LOCALLY = LIVE && onLocalhost;

  let client;
  if (LIVE) {
    if (!window.supabase) {
      throw new Error("supabase-js failed to load, so Blueprint cannot reach the database.");
    }
    client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Same key as the sibling apps → one shared session across the suite.
        storageKey: CFG.AUTH_STORAGE_KEY
      }
    });

    /* Same-origin tabs get a storage event when another tab clears the session.
       Without this, an already-open tab keeps its in-memory session and its
       cached JWT stays valid until expiry, so it would look signed in for up to
       an hour after you signed out elsewhere. */
    window.addEventListener("storage", e => {
      if (e.key === CFG.AUTH_STORAGE_KEY && !e.newValue) location.reload();
    });
  } else if (window.BPMock) {
    client = window.BPMock.createMockClient();
  } else {
    // dev/mock-db.js is not deployed, so this only happens if credentials are
    // missing from a real deployment — worth failing loudly rather than blankly.
    throw new Error(
      "No backend available: SUPABASE_URL is not set and the local mock is not loaded."
    );
  }

  // In local mode, credential links must point at wherever the dev server is
  // running, otherwise every generated link is unclickable.
  const BLUEPRINT_URL = LIVE
    ? CFG.BLUEPRINT_URL
    : location.origin + location.pathname.replace(/[^/]*$/, "");

  /* ------------------------------------------------------------------ auth */

  async function signIn(email, password) {
    const v = BP.validateEmail(email, CFG.ALLOWED_DOMAIN);
    if (!v.ok) return { ok: false, error: v.error };
    const { error } = await client.auth.signInWithPassword({ email: v.email, password });
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true, email: v.email };
  }

  async function currentEmail() {
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.user.email) || null;
  }

  // scope:'global' (the v2 default, stated here so it is not lost in a refactor)
  // revokes refresh tokens server-side, not just locally.
  async function signOut() {
    try {
      await client.auth.signOut({ scope: "global" });
    } catch (_) {
      // Even if the revoke call fails, drop the local session so the browser is
      // signed out rather than stuck in a half-signed-in state.
    }
    try { localStorage.removeItem(CFG.AUTH_STORAGE_KEY); } catch (_) {}
  }

  // Blueprint is the landing page for every credential link, from any app, so
  // it must redeem both token pools. The &pool=cdb tag makes the routing
  // deterministic instead of trial-and-error against an unversioned function.
  async function redeem(token, pool, newPassword) {
    const rpc = pool === "B" ? "cdb_redeem_reset_token" : "redeem_reset_token";
    const { data, error } = await client.rpc(rpc, {
      p_token: token, p_new_password: newPassword
    });
    if (error) return { ok: false, error: friendly(error) };
    if (data && data.ok === false) return { ok: false, error: data.error };
    return { ok: true };
  }

  /* ------------------------------------------------------------- registry */

  async function loadApps() {
    const { data, error } = await client.from("hub_apps").select();
    if (error || !data || !data.length) {
      // hub_apps missing or unreadable — fall back so the launcher still works.
      return { apps: BP.sortApps(CFG.APPS_FALLBACK), fallback: true };
    }
    return { apps: BP.sortApps(data), fallback: false };
  }

  async function addApp(form, existing) {
    const v = BP.validateNewApp(form, existing);
    if (!v.ok) return { ok: false, errors: v.errors };
    const { error } = await client.from("hub_apps").upsert(v.app, { onConflict: "slug" });
    if (error) return { ok: false, errors: [friendly(error)] };
    return { ok: true, app: v.app };
  }

  // Only presentational fields are sent. The wiring columns are additionally
  // protected server-side by a trigger, so this is defence in depth rather
  // than the only guard.
  //
  // `authors` is a Postgres text[]. The edit form collects it as a comma-separated
  // string, and sending that straight through produced
  //   malformed array literal: "Denis Crepes, Stephen Svedman"
  // The add path happened to work because validateNewApp() parses it. Normalising
  // here means every caller is safe rather than each having to remember.
  async function updateApp(slug, patch, app) {
    const clean = BP.pickEditable(patch, app);
    const dropped = BP.rejectedFields(patch);
    if ("authors" in clean) clean.authors = BP.parseAuthors(clean.authors);
    if (!Object.keys(clean).length) return { ok: false, error: "Nothing to update." };
    const { error } = await client.from("hub_apps").update(clean).eq("slug", slug);
    if (error) return { ok: false, error: friendly(error) };
    // Hand back what was actually written so callers update their in-memory copy
    // with the stored shape, not the raw form value.
    return { ok: true, dropped, patch: clean };
  }

  // Registry-only delete. No role table is referenced here, by design: removing
  // a tile must never be able to revoke anyone's access.
  async function removeApp(slug) {
    const { error } = await client.from("hub_apps").delete().eq("slug", slug);
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  }

  /* ---------------------------------------------------------------- users */

  async function loadUsers(apps) {
    const managed = BP.managedApps(apps);
    const rolesByApp = {};
    const failures = [];

    for (const app of managed) {
      const { data, error } = await client.rpc(app.list_rpc);
      if (error) { failures.push({ app: app.name, error: friendly(error) }); rolesByApp[app.slug] = []; }
      else rolesByApp[app.slug] = data || [];
    }

    // last_sign_in is only available from the mock; live Supabase does not
    // expose auth.users to the client, so the column is simply omitted there.
    let lastSignIn = {};
    if (!LIVE) {
      const { data } = await client.from("auth_users").select();
      for (const u of data || []) lastSignIn[u.email] = u.last_sign_in_at;
    }

    return { rows: BP.mergeUsers(rolesByApp, apps, { lastSignIn, defaultRole: CFG.DEFAULT_ROLE }), failures };
  }

  async function setRole(app, email, role, divisions) {
    const row = { email: BP.normalizeEmail(email), role };
    if ((app.division_scoped_roles || []).indexOf(role) !== -1) row.divisions = divisions || [];
    const { error } = await client.from(app.role_table).upsert(row, { onConflict: "email" });
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  }

  async function clearRole(app, email) {
    const { error } = await client.from(app.role_table).delete().eq("email", BP.normalizeEmail(email));
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  }

  /* ---------------------------------------------------------- provisioning */

  async function divisionsFor(app) {
    const src = app.division_source || { kind: "none" };
    if (src.kind === "config") return src.divisions || [];
    if (src.kind === "table") {
      const { data } = await client.from(src.table).select().order("sort");
      return data || [];
    }
    return [];
  }

  // One token per required pool — not one per app. The password lives in the
  // shared auth.users row, so two pool-A grants still need only one link.
  async function provision(email, grants, adminSlugs, apps) {
    const v = BP.validateEmail(email, CFG.ALLOWED_DOMAIN);
    if (!v.ok) return { ok: false, error: v.error };

    const written = [];
    for (const g of grants) {
      /* A grant with no slug is the sentinel for "mint a credential link, assign
         no role" — the admin ticked the link box and left every role unset.
         There is nothing to write, and skipping straight past setRole is the
         whole handling: the pools loop below still mints the link, because
         poolsForGrants reads tokenPool and never looks at slug. */
      if (!g.slug) continue;
      const app = apps.find(a => a.slug === g.slug);
      const r = await setRole(app, v.email, g.role, g.divisions);
      written.push({ app: app.name, role: g.role, divisions: g.divisions, ok: r.ok, error: r.error });
    }

    const links = [];
    for (const pool of BP.poolsForGrants(grants)) {
      const choice = BP.chooseMintRpc(pool, apps, adminSlugs);
      if (!choice.ok) { links.push({ pool, ok: false, error: choice.error }); continue; }
      const { data, error } = await client.rpc(choice.rpc, { target_email: v.email });
      if (error) { links.push({ pool, ok: false, error: friendly(error) }); continue; }
      if (data && data.ok === false) { links.push({ pool, ok: false, error: data.error }); continue; }
      links.push({
        pool, ok: true, created: !!(data && data.created),
        viaApp: choice.viaApp,
        url: BP.buildRecoverUrl(BLUEPRINT_URL, data.token, pool)
      });
    }

    return { ok: true, email: v.email, written, links };
  }

  async function pendingInvites() {
    const { data, error } = await client.rpc("hub_pending_invites");
    if (error) return { ok: false, error: friendly(error), rows: [] };
    return { ok: true, rows: BP.pendingInvites(data || []) };
  }

  /* --------------------------------------------------------------- health */

  /* Counts must come from the server, not from counting fetched rows.
     A plain select is capped (PostgREST defaults to 1000), so a table that grows
     past that silently reports 1000 — and any metric derived from the truncated
     set is wrong too, without looking wrong. head:true fetches no rows at all. */
  async function countExact(table, apply) {
    let q = client.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count: n, error } = await q;
    return error ? null : (n || 0);
  }

  async function count(table, filters) {
    let q = client.from(table).select();
    for (const [col, val] of Object.entries(filters || {})) q = q.eq(col, val);
    const { data, error } = await q;
    return error ? null : (data || []).length;
  }

  async function newest(table, col) {
    const { data, error } = await client.from(table).select().order(col, { ascending: false }).limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  }

  async function reachable(url) {
    // no-cors gives an opaque response: enough to tell "the request completed"
    // from "the host is gone", without needing CORS headers on their site.
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store" });
      return true;
    } catch (_) { return false; }
  }

  /* --------------------------------------------------------------- intake

     Writers for the Data Intake tab. Each one reproduces exactly what the owning
     app writes when you upload to it directly — same tables, same columns, same
     history rows. That is the whole contract: intake changes where you drop the
     file, not what lands in the database.

     Three things in particular are load-bearing and easy to drop:

       · division_data.prev_payload / prev_updated_at / prev_by. Publishing
         replaces a division wholesale, and these three columns are the only way
         back. Vendor Assignments' Rollback panel reads them.
       · change_log and tf_change_log. The "What's New" panel and the change
         history are rendered from these, so an import that skips them is an
         import that silently never happened as far as users can tell.
       · tf_change_log.detail. The panel expands each entry into tables built from
         detail.added and detail.dateChanges. A summary with no detail renders an
         entry that opens onto nothing.

     Every writer returns { ok, error } and each is called independently, so one
     destination failing leaves the others published rather than rolling back a
     batch that has no transaction spanning it anyway.                          */

  const uid = () =>
    (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });

  // PostgREST caps a request body long before Postgres cares, and Takeoff Flow
  // already settled on 500 rows a call. Same number here so the two behave alike.
  const CHUNK = 500;

  async function bulk(op, table, rows, extra) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { error } = op === "upsert"
        ? await client.from(table).upsert(slice, extra)
        : await client.from(table).insert(slice);
      if (error) throw error;
    }
  }

  /* Which destinations may this person publish to? Read from each app's own role
     table rather than assumed from Blueprint admin: being able to see the tab is
     not the same as being allowed to replace a division.

     A person can always read their own row (every app's select policy allows
     `email = self`), so this works for editors, not just admins. A missing row
     means viewer, which means no.                                              */
  async function intakeRoles(email) {
    const out = { vendorPortal: null, takeoffFlow: null, map: null };
    const e = BP.normalizeEmail(email);

    async function roleIn(table) {
      const { data, error } = await client.from(table).select("role,divisions").eq("email", e).maybeSingle();
      if (error || !data) return null;
      return { role: data.role, divisions: data.divisions || [] };
    }

    out.vendorPortal = await roleIn("app_roles");
    out.takeoffFlow  = await roleIn("tf_app_roles");
    // The map is gated on the Vendor Assignments role by design — see
    // map_can_write() in the map's SQL.
    out.map = out.vendorPortal;
    return out;
  }

  // admin publishes any division; editor only the divisions on their row.
  function canPublish(roleRow, division) {
    if (!roleRow) return false;
    if (roleRow.role === "admin") return true;
    if (roleRow.role === "editor") return (roleRow.divisions || []).indexOf(division) !== -1;
    return false;
  }

  /* ---- Vendor Assignments ---- */

  // The published payload for a division, or null. Intake needs this for two
  // separate reasons and neither is optional: the diff written to change_log, and
  // the guard that refuses a publish which would gut the division.
  async function vendorCurrent(key) {
    const { data, error } = await client.from("division_data")
      .select("payload,updated_at,updated_by").eq("key", key).maybeSingle();
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true, row: data || null, payload: (data && data.payload) || null };
  }

  async function vendorPublish(key, payload, summary, email) {
    try {
      // Re-read immediately before writing rather than trusting what the preview
      // fetched. A preview can sit on screen for minutes while someone else
      // publishes, and prev_payload must point at what is actually being
      // replaced or the rollback restores the wrong version.
      const { data: prevRow } = await client.from("division_data")
        .select("payload,updated_at,updated_by").eq("key", key).maybeSingle();

      const clean = Object.assign({}, payload);
      delete clean._diag;   // diagnostics are for the preview, not the payload

      const { error } = await client.from("division_data").upsert({
        key,
        label: clean.division,
        payload: clean,
        updated_at: new Date().toISOString(),
        updated_by: email,
        prev_payload: prevRow ? prevRow.payload : null,
        prev_updated_at: prevRow ? prevRow.updated_at : null,
        prev_by: prevRow ? prevRow.updated_by : null
      }, { onConflict: "key" });
      if (error) throw error;

      // Best-effort, exactly as the app treats it: the data is published either
      // way, and failing the whole publish because the history row did not land
      // would be the worse outcome.
      const { error: logErr } = await client.from("change_log")
        .insert({ key, actor: email, summary });
      return { ok: true, historyWritten: !logErr, historyError: logErr ? friendly(logErr) : null };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  }

  /* ---- Takeoff Flow ---- */

  async function flowExisting(division) {
    const { data, error } = await client.from("flow_rows")
      .select("id,community_name,community_num,plan,elevation,first_trench_date,plan_name,sort_order")
      .eq("division", division);
    if (error) return { ok: false, error: friendly(error), rows: [] };
    return { ok: true, rows: data || [] };
  }

  /* Adds new rows and nudges first_trench_date on existing ones. Existing rows are
     never replaced wholesale — an editor's manual overrides in the grid have to
     survive an import, which is why the update is a partial upsert of two columns
     and not the parsed row. */
  async function flowPublish(division, fresh, updates, entry, email) {
    try {
      const ex = await flowExisting(division);
      if (!ex.ok) return { ok: false, error: ex.error };

      let n = ex.rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0);
      const now = new Date().toISOString();

      const newRows = fresh.map(p => {
        const row = { id: uid(), division, sort_order: ++n, updated_at: now, updated_by: email };
        for (const k in p) if (k !== "id" && k !== "division" && k !== "sort_order") row[k] = p[k];
        return row;
      });

      // One row per id: the planner already collapsed duplicates, but a batch that
      // touched the same id twice would fail the whole upsert.
      const byId = new Map();
      (updates || []).forEach(u => byId.set(u.id, u));
      const updRows = [...byId.values()].map(u => {
        const row = { id: u.id, division, updated_at: now, updated_by: email };
        if (u.trTo) row.first_trench_date = u.trTo;
        return row;
      });

      if (newRows.length) await bulk("insert", "flow_rows", newRows);
      if (updRows.length) await bulk("upsert", "flow_rows", updRows, { onConflict: "id" });

      // What's New. detail carries the per-row tables the panel expands into.
      const { error: logErr } = await client.from("tf_change_log").insert({
        id: uid(), division, at: new Date().toISOString(), by: email,
        summary: entry.summary, detail: entry.detail || null
      });

      return {
        ok: true, added: newRows.length, updated: updRows.length,
        historyWritten: !logErr, historyError: logErr ? friendly(logErr) : null
      };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  }

  /* ---- Community Map ---- */

  /* Health metrics for the map. It has no role table, so it used to fall into the
     "not managed here" branch and get reported as having a separate backend — but
     its document is in this database and Blueprint publishes it, so there is real
     state to check.

     Reads the payload rather than counting rows, because the map is one row: the
     whole document is a single jsonb value, so the interesting numbers are inside
     it. That is also why this is map-shaped rather than generic — a second app
     with a data_table would want its own reader. */
  async function mapHealth(key) {
    const { data, error } = await client.from("map_data")
      .select("payload,updated_at,updated_by").eq("key", key || "orlando").maybeSingle();
    if (error) return { ok: false, error: friendly(error) };
    if (!data) return { ok: true, seeded: false };

    const comms = (data.payload && data.payload.communities) || [];
    const placeable = c => Number.isFinite(c.lat) && Number.isFinite(c.lon)
                        && !(c.lat === 0 && c.lon === 0);
    const unlocated = comms.filter(c => !placeable(c));

    return {
      ok: true, seeded: true,
      publishedAt: data.updated_at || null,
      publishedBy: data.updated_by || null,
      communities: comms.length,
      plotted: comms.length - unlocated.length,
      unlocated: unlocated.length,
      // Starts held back with them. Three communities sounds like housekeeping;
      // a hundred starts missing from the map does not.
      unlocatedStarts: unlocated.reduce(
        (a, c) => a + (c.starts || []).reduce((x, y) => x + y, 0), 0),
      dataStart: (data.payload && data.payload.dataStart) || null
    };
  }

  /* Where Community-DB thinks each community is.

     Community Information Sheets are filled in long before a community's first
     permit, and they carry "City, State, Zip" and the permitting municipality
     against a JDE number — which normalises to exactly the community number the
     map uses, so this is an exact join rather than a name match. That locality is
     the one thing on hand that can place a brand-new community: the permit log
     gives street names and nothing else, and a street name without a town is a
     question about a whole state.

     Read through the signed-in session, so RLS applies: a viewer sees published
     sheets, an editor sees drafts too. That is the right way round — map-core
     prefers a published sheet and labels a draft as one.

     Never fatal. A failure here means fewer communities can be placed, which is
     the state the map was in before this existed; it must not stop an import. */
  async function mapLocalities(division) {
    const { data, error } = await client.from("cdb_cis")
      .select("jde,status,data")
      .eq("division", division || "orlando")
      .not("jde", "is", null);
    if (error) return { ok: false, error: friendly(error), by: {}, sheets: 0 };
    const rows = data || [];
    return { ok: true, by: MAPCORE.localitiesFrom(rows), sheets: rows.length };
  }

  async function mapCurrent(key) {
    const { data, error } = await client.from("map_data")
      .select("payload,people,updated_at,updated_by").eq("key", key).maybeSingle();
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true, row: data || null };
  }

  async function mapPublish(key, label, payload, people, summary, email) {
    try {
      const { data: prevRow } = await client.from("map_data")
        .select("payload,people,updated_at,updated_by").eq("key", key).maybeSingle();

      const { error } = await client.from("map_data").upsert({
        key, label, payload, people,
        updated_at: new Date().toISOString(),
        updated_by: email,
        prev_payload: prevRow ? prevRow.payload : null,
        prev_people: prevRow ? prevRow.people : null,
        prev_updated_at: prevRow ? prevRow.updated_at : null,
        prev_by: prevRow ? prevRow.updated_by : null
      }, { onConflict: "key" });
      if (error) throw error;

      const { error: logErr } = await client.from("map_change_log")
        .insert({ key, actor: email, summary });
      return { ok: true, historyWritten: !logErr, historyError: logErr ? friendly(logErr) : null };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  }

  /* --------------------------------------------------------------- errors */

  function friendly(error) {
    const m = (error && error.message) || String(error);
    if (/Invalid login credentials/i.test(m)) return "That email and password don't match an account.";
    if (/not authorized/i.test(m)) return "You aren't an admin for that app, so this action was refused.";
    if (/does not exist/i.test(m)) return "That function isn't installed in the database yet — run supabase_setup.sql.";
    if (/duplicate key/i.test(m)) return "That already exists.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Couldn't reach the database. Check your connection.";
    return m;
  }

  return {
    LIVE, FORCED_LIVE_LOCALLY, onLocalhost, client, BLUEPRINT_URL,
    signIn, currentEmail, signOut, redeem,
    loadApps, addApp, updateApp, removeApp,
    loadUsers, setRole, clearRole,
    divisionsFor, provision, pendingInvites,
    count, countExact, newest, reachable, friendly,
    intakeRoles, canPublish,
    vendorCurrent, vendorPublish,
    flowExisting, flowPublish,
    mapCurrent, mapPublish, mapHealth, mapLocalities
  };
})();
