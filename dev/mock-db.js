/* ============================================================================
   Blueprint — mock-db.js
   An in-memory stand-in for the subset of supabase-js that Blueprint uses, so
   the whole app runs locally with no network, no credentials and no risk of
   touching production data.

   It implements the real client's *shape* (thenable query builders, {data,error}
   envelopes, .rpc()) rather than a convenient shortcut, so app.js can be written
   against the genuine API and later point at real Supabase with a one-line
   config change and no code edits.

   Seeded with data that mirrors the live schema closely enough to be useful:
   three managed apps + one launcher-only, asymmetric per-app roles, and a mix
   of redeemed, pending and expired invite tokens.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BPMock = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;
  const iso = ms => new Date(ms).toISOString();

  // ---------------------------------------------------------------------------
  // ALL NAMES AND ADDRESSES BELOW ARE FICTIONAL.
  // This file is committed to a public repository, so it must never contain real
  // colleagues, real role assignments, or anything else about how the
  // organisation is actually structured. Keep it that way when adding fixtures.
  // ---------------------------------------------------------------------------
  function seed(nowMs) {
    const now = nowMs || Date.now();
    return {
      // ---- shared identity ------------------------------------------------
      auth_users: [
        { email: "avery.stone@lennar.com", last_sign_in_at: iso(now - 2 * 3600e3) },
        { email: "jordan.blake@lennar.com",  last_sign_in_at: iso(now - 2 * DAY) },
        { email: "casey.morgan@lennar.com",   last_sign_in_at: iso(now - 5 * 3600e3) },
        { email: "riley.novak@lennar.com",      last_sign_in_at: iso(now - 5 * DAY) },
        { email: "quinn.harper@lennar.com",   last_sign_in_at: null },
        { email: "morgan.diaz@lennar.com", last_sign_in_at: iso(now - 9 * DAY) },
        { email: "taylor.reed@lennar.com",    last_sign_in_at: iso(now - 1 * DAY) },
        { email: "sam.ellis@lennar.com",     last_sign_in_at: null }
      ],

      // ---- Blueprint's own registry ---------------------------------------
      hub_apps: [
        { slug: "Vendor-Portal", name: "Vendor Assignments",
          url: "https://ssvedman.github.io/Vendor-Portal/",
          description: "Division vendor assignments, coverage gaps and starts, imported from E1 exports.",
          icon_url: "icons/vendor-portal.svg", authors: ["Stephen Svedman"], active: true,
          auth_kind: "shared",
          role_table: "app_roles", list_rpc: "admin_list_users", token_rpc: "admin_add_or_reset",
          token_pool: "A", roles: ["admin", "editor", "viewer"],
          division_scoped_roles: ["editor"],
          division_source: { kind: "table", table: "app_divisions" } },

        { slug: "Takeoff-Flow", name: "Takeoff Flow",
          url: "https://ssvedman.github.io/Takeoff-Flow/",
          description: "Editable takeoff schedule with WORKDAY date math, pending budgets and change log.",
          icon_url: "icons/takeoff-flow.svg", authors: ["Stephen Svedman"], active: true,
          auth_kind: "shared",
          role_table: "tf_app_roles", list_rpc: "tf_admin_list_users", token_rpc: "tf_admin_add_or_reset",
          token_pool: "A", roles: ["admin", "editor", "purchasing", "viewer"],
          division_scoped_roles: ["editor", "purchasing"],
          division_source: { kind: "config", divisions: [
            { key: "tampa", label: "Tampa", code: "TPU" },
            { key: "orlando", label: "Orlando", code: "OLH" }] } },

        { slug: "Community-DB", name: "Community-DB",
          url: "https://ssvedman.github.io/Community-DB/",
          description: "Community information sheets with draft/publish workflow, images and meeting notes.",
          icon_url: "icons/community-db.svg",
          authors: ["Denis Crepes", "Stephen Svedman"], active: true,
          auth_kind: "shared",
          role_table: "cdb_app_roles", list_rpc: "cdb_admin_list_users",
          token_rpc: "cdb_admin_add_or_reset",
          token_pool: "B", roles: ["admin", "editor", "viewer"],
          division_scoped_roles: [],
          division_source: { kind: "config", divisions: [
            { key: "orlando", label: "Orlando Division", code: "OLH" }] } },

        { slug: "lennar-map", name: "Community Map",
          url: "https://grant-slater.github.io/lennar-map/",
          description: "Orlando division community map — starts by month, trade-partner and vendor filters, utilities and municipality.",
          icon_url: null, authors: ["Grant Slater"], active: true,
          auth_kind: "none",
          role_table: null, list_rpc: null, token_rpc: null, token_pool: null,
          roles: [], division_scoped_roles: [],
          division_source: { kind: "none" } }
      ],

      // ---- per-app roles. Deliberately asymmetric: Jennifer is an editor in
      //      Vendor Assignments but purchasing in Takeoff Flow.
      app_roles: [
        { email: "avery.stone@lennar.com", role: "admin",  divisions: [] },
        { email: "jordan.blake@lennar.com",  role: "editor", divisions: ["tampa"] },
        { email: "casey.morgan@lennar.com",   role: "editor", divisions: ["orlando"] }
      ],
      tf_app_roles: [
        { email: "avery.stone@lennar.com", role: "admin",      divisions: [] },
        { email: "jordan.blake@lennar.com",  role: "purchasing", divisions: ["tampa"] },
        { email: "casey.morgan@lennar.com",   role: "editor",     divisions: ["orlando"] },
        { email: "riley.novak@lennar.com",      role: "purchasing", divisions: ["orlando"] },
        { email: "quinn.harper@lennar.com",   role: "purchasing", divisions: [] }
      ],
      cdb_app_roles: [
        { email: "avery.stone@lennar.com", role: "admin"  },
        { email: "taylor.reed@lennar.com",    role: "admin"  },
        { email: "casey.morgan@lennar.com",   role: "editor" },
        { email: "morgan.diaz@lennar.com", role: "editor" }
      ],

      // ---- token pools ----------------------------------------------------
      // Pool A stores expires_at; pool B stores only created_at.
      password_reset_tokens: [
        { token: "a41f9c7e2b08d5136ea0f7c4", email: "sam.ellis@lennar.com",
          created_at: iso(now - 3 * 3600e3), expires_at: iso(now + 21 * 3600e3), used_at: null },
        { token: "e7c1b9042daf6835", email: "quinn.harper@lennar.com",
          created_at: iso(now - 40 * DAY), expires_at: iso(now - 39 * DAY), used_at: null },
        { token: "9f3ab7712cc40d51", email: "riley.novak@lennar.com",
          created_at: iso(now - 6 * DAY), expires_at: iso(now - 5 * DAY), used_at: iso(now - 5.5 * DAY) }
      ],
      cdb_reset_tokens: [
        { token: "bb20f61c9e7a4d33", email: "morgan.diaz@lennar.com",
          created_at: iso(now - 2 * DAY), used_at: null },
        { token: "1d90ae55f0c2b784", email: "taylor.reed@lennar.com",
          created_at: iso(now - 30 * DAY), used_at: null }
      ],

      // ---- health sources -------------------------------------------------
      app_divisions: [
        { key: "tampa", label: "Tampa", code: "TPU", sort: 1 },
        { key: "orlando", label: "Orlando", code: "OLH", sort: 2 }
      ],
      division_data: [
        { key: "tampa", updated_at: iso(now - 3 * DAY), updated_by: "casey.morgan@lennar.com", prev_payload: {} },
        { key: "orlando", updated_at: iso(now - 3 * DAY), updated_by: "casey.morgan@lennar.com", prev_payload: {} }
      ],
      change_log: Array.from({ length: 47 }, (_, i) => ({
        id: i + 1, key: i % 2 ? "tampa" : "orlando",
        actor: "casey.morgan@lennar.com", summary: "Vendor assignments updated",
        created_at: iso(now - (i + 3) * DAY)
      })),
      // Mirrors the live schema: plan_name is an optional manual override and is
      // normally null (the name comes from tf_plan_names), missing_plans is the
      // free-text flag the app's To-Do list reads, and first_trench_date drives
      // every calculated date column. Two divisions, so division-agnostic
      // aggregation is actually exercised.
      flow_rows: Array.from({ length: 636 }, (_, i) => ({
        id: "f" + i,
        division: i % 3 === 0 ? "tampa" : "orlando",
        plan: "P" + (1000 + i),
        plan_name: i % 7 === 0 ? "Manual override " + i : null,
        missing_plans: i < 5 ? "waiting on architect" : null,
        first_trench_date: i < 3 ? null : "2026-1" + (i % 2) + "-01",
        updated_at: iso(now - (i % 5) * 3600e3)
      })),
      // `name`, not `label` — and one column deliberately has no assignee so the
      // health check has something to report. Spread over both divisions.
      pending_budget_cols: ["Jordan", "Casey", "Morgan", "Riley", "Quinn", "Avery"].map((n, i) => ({
        id: "c" + i,
        division: i % 2 ? "tampa" : "orlando",
        name: n,
        assigned_email: i === 5 ? null : n.toLowerCase() + "@lennar.com",
        sort_order: i
      })),
      takeoff_changes: [
        { id: "t1", division: "orlando", complete: false, request: "Add cabinet option" },
        { id: "t2", division: "tampa",   complete: false, request: "Revise flooring" },
        { id: "t3", division: "orlando", complete: true,  complete_date: iso(now - 2 * DAY),
          request: "Elevation change" },
        { id: "t4", division: "tampa",   complete: true,  request: "Plan swap" }
      ],
      tf_change_log: [{ at: iso(now - 4 * 3600e3), by: "casey.morgan@lennar.com", summary: "Imported flow" }],
      cdb_cis: [
        ...Array.from({ length: 61 }, (_, i) => ({
          id: "p" + i, community_id: "c" + i, status: "published", division: "orlando",
          needs_review: i < 2, active: true, published_at: iso(now - 12 * DAY)
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: "d" + i, community_id: "c" + (100 + i), status: "draft", division: "orlando",
          needs_review: false, active: true, updated_at: iso(now - 12 * DAY)
        }))
      ],
      cdb_cis_revisions: [{ community_id: "c0", published_at: iso(now - 12 * DAY) }],
      cdb_images: Array.from({ length: 203 }, (_, i) => ({ id: "i" + i, community_id: "c" + (i % 61) }))
    };
  }

  /* ------------------------------------------------------- query builder --- */

  // Thenable so `await client.from(t).select()` works exactly as it does with
  // the real client, including the {data,error} envelope.
  /* Columns that are Postgres arrays. The mock previously accepted anything, so
     sending a comma-separated string where a text[] was expected passed locally
     and only failed against the real database with
       malformed array literal: "Denis Crepes, Stephen Svedman"
     Mirroring the type check here means that class of bug fails in the test run
     instead of in production. */
  const ARRAY_COLUMNS = {
    hub_apps: ["authors", "roles", "division_scoped_roles"],
    app_roles: ["divisions"],
    tf_app_roles: ["divisions"]
  };

  function typeError(table, rows) {
    for (const row of [].concat(rows || [])) {
      if (!row || typeof row !== "object") continue;
      for (const col of ARRAY_COLUMNS[table] || []) {
        if (!(col in row)) continue;
        const v = row[col];
        if (v == null) continue;
        if (!Array.isArray(v)) {
          return { message: 'malformed array literal: "' + String(v) + '"' };
        }
      }
    }
    return null;
  }

  function makeQuery(db, table, log) {
    const state = { table, op: "select", filters: [], order: null, limit: null, single: null, rows: null };

    function rows() {
      let r = (db[table] || []).slice();
      for (const f of state.filters) {
        r = r.filter(x => {
          const v = x[f.col];
          if (f.op === "eq") return String(v) === String(f.val);
          if (f.op === "neq") return String(v) !== String(f.val);
          if (f.op === "is") return f.val === null ? (v == null) : v === f.val;
          if (f.op === "in") return f.val.includes(v);
          return true;
        });
      }
      if (state.order) {
        const { col, asc } = state.order;
        r.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (state.limit != null) r = r.slice(0, state.limit);
      return r;
    }

    function run() {
      log.push({ table, op: state.op, filters: state.filters.slice() });
      if (state.rows) {
        const te = typeError(table, state.rows);
        if (te) return { data: null, error: te };
      }
      try {
        if (state.op === "select") {
          const r = rows();
          if (state.single === "one") {
            if (r.length !== 1) return { data: null, error: { message: "Expected one row, got " + r.length } };
            return { data: r[0], error: null };
          }
          if (state.single === "maybe") return { data: r[0] || null, error: null };
          return { data: r, error: null };
        }
        if (state.op === "insert" || state.op === "upsert") {
          db[table] = db[table] || [];
          const key = state.conflict || "email";
          for (const row of state.rows) {
            const i = db[table].findIndex(x => String(x[key]) === String(row[key]));
            if (i >= 0 && state.op === "upsert") db[table][i] = { ...db[table][i], ...row };
            else if (i >= 0) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
            else db[table].push({ ...row });
          }
          return { data: state.rows, error: null };
        }
        if (state.op === "update") {
          const targets = rows();
          for (const t of targets) Object.assign(t, state.rows[0]);
          return { data: targets, error: null };
        }
        if (state.op === "delete") {
          const targets = rows();
          db[table] = (db[table] || []).filter(x => !targets.includes(x));
          return { data: targets, error: null };
        }
        return { data: null, error: { message: "Unsupported op " + state.op } };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    }

    const q = {
      select() { state.op = state.op === "select" ? "select" : state.op; return q; },
      insert(r) { state.op = "insert"; state.rows = [].concat(r); return q; },
      upsert(r, o) { state.op = "upsert"; state.rows = [].concat(r); state.conflict = o && o.onConflict; return q; },
      update(r) { state.op = "update"; state.rows = [r]; return q; },
      delete() { state.op = "delete"; return q; },
      eq(c, v) { state.filters.push({ col: c, op: "eq", val: v }); return q; },
      neq(c, v) { state.filters.push({ col: c, op: "neq", val: v }); return q; },
      is(c, v) { state.filters.push({ col: c, op: "is", val: v }); return q; },
      in(c, v) { state.filters.push({ col: c, op: "in", val: v }); return q; },
      order(c, o) { state.order = { col: c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { state.limit = n; return q; },
      single() { state.single = "one"; return q; },
      maybeSingle() { state.single = "maybe"; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); }
    };
    return q;
  }

  /* -------------------------------------------------------------- client --- */

  function createMockClient(opts) {
    const options = opts || {};
    const nowRef = { ms: options.now || Date.now() };
    const db = seed(nowRef.ms);
    const log = [];
    let session = null;

    function callerEmail() {
      return session ? session.email : null;
    }
    function roleIn(table, email) {
      const row = (db[table] || []).find(r => r.email === (email || "").toLowerCase());
      return row ? row.role : "viewer";
    }
    function isAdminOf(table) {
      return roleIn(table, callerEmail()) === "admin";
    }
    function anyAdmin() {
      return ["app_roles", "tf_app_roles", "cdb_app_roles"].some(isAdminOf);
    }
    function randToken() {
      let s = "";
      for (let i = 0; i < 24; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      return s;
    }

    // Mirrors the real SQL: refuses unless the caller is an admin in the role
    // table that specific function checks. This is what makes chooseMintRpc()
    // worth testing rather than assuming.
    function mintToken(roleTable, pool, targetEmail) {
      if (!isAdminOf(roleTable)) {
        return { data: null, error: { message: "not authorized" } };
      }
      const email = (targetEmail || "").trim().toLowerCase();
      if (!email.endsWith("@lennar.com")) {
        return { data: null, error: { message: "Email must be @lennar.com." } };
      }
      let created = false;
      if (!db.auth_users.some(u => u.email === email)) {
        db.auth_users.push({ email, last_sign_in_at: null });
        created = true;
      }
      const token = randToken();
      if (pool === "A") {
        db.password_reset_tokens.push({
          token, email, created_at: iso(nowRef.ms),
          expires_at: iso(nowRef.ms + DAY), used_at: null
        });
      } else {
        db.cdb_reset_tokens.push({ token, email, created_at: iso(nowRef.ms), used_at: null });
      }
      return { data: { ok: true, token, email, created }, error: null };
    }

    function listUsers(roleTable) {
      if (!isAdminOf(roleTable)) return { data: null, error: { message: "not authorized" } };
      return {
        data: db.auth_users.map(u => {
          const row = (db[roleTable] || []).find(r => r.email === u.email);
          return {
            email: u.email,
            role: row ? row.role : "viewer",
            divisions: (row && row.divisions) || [],
            explicit: !!row
          };
        }),
        error: null
      };
    }

    const rpcs = {
      // --- invite minting, one per role table (matching the live schema) ----
      admin_add_or_reset:     a => mintToken("app_roles", "A", a.target_email),
      tf_admin_add_or_reset:  a => mintToken("tf_app_roles", "A", a.target_email),
      cdb_admin_add_or_reset: a => mintToken("cdb_app_roles", "B", a.target_email),

      admin_list_users:     () => listUsers("app_roles"),
      tf_admin_list_users:  () => listUsers("tf_app_roles"),
      cdb_admin_list_users: () => listUsers("cdb_app_roles"),

      // --- redemption ------------------------------------------------------
      redeem_reset_token: a => redeem(db.password_reset_tokens, a, false),
      cdb_redeem_reset_token: a => redeem(db.cdb_reset_tokens, a, true),

      // --- health: security definer, returns NO token column ---------------
      hub_pending_invites: () => {
        if (!anyAdmin()) return { data: null, error: { message: "not authorized" } };
        const out = [];
        for (const r of db.password_reset_tokens) {
          if (r.used_at) continue;
          out.push({ email: r.email, pool: "A", created_at: r.created_at, expires_at: r.expires_at });
        }
        for (const r of db.cdb_reset_tokens) {
          if (r.used_at) continue;
          out.push({
            email: r.email, pool: "B", created_at: r.created_at,
            expires_at: iso(new Date(r.created_at).getTime() + 14 * DAY)
          });
        }
        return { data: out, error: null };
      },

      is_any_admin: () => ({ data: anyAdmin(), error: null })
    };

    function redeem(pool, a, computeTtl) {
      const row = pool.find(t => t.token === a.p_token);
      if (!row) return { data: { ok: false, error: "Invalid link." }, error: null };
      if (row.used_at) return { data: { ok: false, error: "This link was already used." }, error: null };
      const exp = computeTtl
        ? new Date(row.created_at).getTime() + 14 * DAY
        : new Date(row.expires_at).getTime();
      if (nowRef.ms > exp) return { data: { ok: false, error: "This link has expired." }, error: null };
      if ((a.p_new_password || "").length < 8) {
        return { data: { ok: false, error: "Password must be at least 8 characters." }, error: null };
      }
      row.used_at = iso(nowRef.ms);
      const u = db.auth_users.find(x => x.email === row.email);
      if (u) u.last_sign_in_at = iso(nowRef.ms);
      return { data: { ok: true }, error: null };
    }

    return {
      __mock: true,
      __db: db,
      __log: log,
      __setNow(ms) { nowRef.ms = ms; },
      __signInAs(email) { session = { email: (email || "").toLowerCase() }; return session; },

      from(table) { return makeQuery(db, table, log); },

      rpc(name, args) {
        log.push({ rpc: name, args });
        const fn = rpcs[name];
        if (!fn) return Promise.resolve({ data: null, error: { message: 'function "' + name + '" does not exist' } });
        return Promise.resolve(fn(args || {}));
      },

      auth: {
        async signInWithPassword({ email, password }) {
          const e = (email || "").trim().toLowerCase();
          if (!db.auth_users.some(u => u.email === e)) {
            return { data: null, error: { message: "Invalid login credentials" } };
          }
          // Local dev accepts any password of a plausible length; the point is
          // exercising the UI, not simulating bcrypt.
          if ((password || "").length < 4) {
            return { data: null, error: { message: "Invalid login credentials" } };
          }
          session = { email: e };
          const u = db.auth_users.find(x => x.email === e);
          u.last_sign_in_at = iso(nowRef.ms);
          return { data: { user: { email: e } }, error: null };
        },
        async getSession() {
          return { data: { session: session ? { user: { email: session.email } } : null }, error: null };
        },
        async signOut() { session = null; return { error: null }; }
      }
    };
  }

  return { createMockClient, seed };
});
