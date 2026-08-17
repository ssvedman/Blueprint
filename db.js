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
    client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
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

  async function signOut() { await client.auth.signOut(); }

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
    count, newest, reachable, friendly
  };
})();
