/* ============================================================================
   Blueprint — core.js
   Pure logic, no DOM and no network. Everything here is unit-testable in node
   and reused verbatim by the browser, so the rules that matter (ordering, role
   merging, validation, expiry) have exactly one implementation.

   Loaded in the browser as window.BP; required in node as module.exports.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BP = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- ordering */

  // Punctuation- and space-insensitive so "Community-DB" sorts before
  // "Community Map" (compares CommunityDB vs CommunityMap). A naive compare
  // orders them the other way, because U+0020 < U+002D.
  const collator = new Intl.Collator("en", {
    ignorePunctuation: true,
    sensitivity: "base",
    numeric: true
  });

  function byName(a, b) {
    return collator.compare(nameOf(a), nameOf(b));
  }
  function nameOf(x) {
    return (x && typeof x === "object" ? x.name || x.label || x.slug || "" : x || "") + "";
  }
  function sortApps(apps) {
    return (apps || []).slice().sort(byName);
  }
  function sortEmails(emails) {
    return (emails || []).slice().sort((a, b) => collator.compare(emailOf(a), emailOf(b)));
  }
  function emailOf(x) {
    return ((x && typeof x === "object" ? x.email : x) || "") + "";
  }

  /* -------------------------------------------------------------- app registry */

  /* How an app authenticates. This started as a binary — either it used this
     hub's Supabase sign-in, or it was assumed public — which mislabelled any
     Lennar app behind Entra ID as "Public · no sign-in". That is not a cosmetic
     error: it tells the reader an internal tool is open to anyone with the link.

     "Managed" and "authenticated" are separate questions. An Entra app is fully
     authenticated but its roles live in Entra, so Blueprint cannot administer it
     and it stays out of Users. Only `shared` apps appear there.                */
  const AUTH_KINDS = {
    shared: { label: "Shared sign-in",     tone: "ok",
              note: "Uses this hub's sign-in; roles managed here" },
    entra:  { label: "Lennar sign-in",     tone: "info",
              note: "Microsoft Entra ID; access managed in Entra, not here" },
    other:  { label: "External sign-in",   tone: "info",
              note: "Has its own sign-in; access managed in that app" },
    none:   { label: "Public · no sign-in", tone: "warn",
              note: "Anyone with the link can open it" }
  };

  // Falls back for rows written before auth_kind existed: a role table implies
  // the shared sign-in, and anything else was previously assumed public.
  function authKind(app) {
    const k = app && app.auth_kind;
    if (k && AUTH_KINDS[k]) return k;
    return app && app.role_table ? "shared" : "none";
  }
  function authMeta(app) {
    return AUTH_KINDS[authKind(app)];
  }

  // An app is "managed" when it has a role table: it then appears in Users and
  // the role-based parts of Health. Everything else is a tile — which now
  // includes authenticated apps whose roles Blueprint does not own.
  function isManaged(app) {
    return !!(app && app.role_table);
  }
  function managedApps(apps) {
    return sortApps(apps).filter(isManaged);
  }
  function activeApps(apps) {
    return sortApps(apps).filter(a => a && a.active !== false);
  }

  // Blueprint interpolates role_table / *_rpc into queries, so these are never
  // admin-editable. Anything not on this list is rejected by saveApp().
  // auth_kind is editable: it names no table and grants nothing, it just tells
  // the reader how to get in. The one invariant is enforced below — an app may
  // only claim the shared sign-in if it actually has a role table.
  const EDITABLE_APP_FIELDS = [
    "name", "url", "description", "icon_url", "authors", "active", "auth_kind"
  ];

  function pickEditable(patch, app) {
    const out = {};
    for (const k of EDITABLE_APP_FIELDS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    }
    if (out.auth_kind && !AUTH_KINDS[out.auth_kind]) delete out.auth_kind;
    // Claiming the shared sign-in without a role table would put an app in the
    // Users tab with nothing to read. Refuse rather than half-apply.
    if (out.auth_kind === "shared" && app && !app.role_table) delete out.auth_kind;
    return out;
  }
  function rejectedFields(patch) {
    return Object.keys(patch || {}).filter(k => EDITABLE_APP_FIELDS.indexOf(k) === -1);
  }

  function slugify(name) {
    return (name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // Removing an app is a registry-only delete. Enumerating what is *not*
  // touched here keeps the confirm dialog honest and testable.
  function removalImpact(app) {
    return {
      slug: app && app.slug,
      registryRowDeleted: true,
      roleTableTouched: false,
      roleTable: (app && app.role_table) || null,
      usersLosingAccess: 0,
      appKeepsRunning: true,
      lostFields: ["description", "authors", "icon_url"],
      reversible: false,
      note: isManaged(app)
        ? "Removes the Blueprint tile only. " + app.role_table +
          " is untouched, so nobody loses access to the app itself."
        : "Removes the Blueprint tile only. The site keeps running."
    };
  }

  /* --------------------------------------------------------------- validation */

  function normalizeEmail(e) {
    return ((e || "") + "").trim().toLowerCase();
  }

  function validateEmail(email, allowedDomain) {
    const e = normalizeEmail(email);
    if (!e) return { ok: false, error: "Enter an email address." };
    // Deliberately strict rather than clever: one @, no spaces, a dotted host.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: "That is not a valid email address." };
    }
    if (allowedDomain && !e.endsWith(allowedDomain)) {
      return { ok: false, error: "Email must be a " + allowedDomain + " address." };
    }
    return { ok: true, email: e };
  }

  function validateUrl(url) {
    const u = ((url || "") + "").trim();
    if (!u) return { ok: false, error: "Enter a URL." };
    if (!/^https:\/\//i.test(u)) {
      return { ok: false, error: "URL must start with https:// ." };
    }
    try {
      new URL(u);
    } catch (_) {
      return { ok: false, error: "That URL could not be parsed." };
    }
    return { ok: true, url: u.endsWith("/") ? u : u + "/" };
  }

  function validateNewApp(form, existingApps) {
    const errors = [];
    const name = ((form && form.name) || "").trim();
    if (!name) errors.push("Name is required.");
    const u = validateUrl(form && form.url);
    if (!u.ok) errors.push(u.error);

    const slug = slugify(name);
    if (name && !slug) errors.push("Name must contain at least one letter or number.");
    if (slug && (existingApps || []).some(a => a.slug === slug)) {
      errors.push('An app with the slug "' + slug + '" already exists.');
    }
    // Name uniqueness matters independently of slug: two tiles reading
    // "Community Map" would be ambiguous on the launcher and unorderable
    // against each other, even though their slugs differ.
    if (name && (existingApps || []).some(a => collator.compare(a.name || "", name) === 0)) {
      errors.push('An app named "' + name + '" already exists.');
    }
    return errors.length
      ? { ok: false, errors }
      : {
          ok: true,
          app: {
            slug,
            name,
            url: u.url,
            description: ((form.description || "") + "").trim() || null,
            icon_url: form.icon_url || null,
            authors: parseAuthors(form.authors),
            active: true,
            // Wiring stays null: a new app is launcher-only until someone
            // writes the SQL. The form cannot grant itself a role table.
            role_table: null, list_rpc: null, token_rpc: null, token_pool: null,
            roles: [],
            division_source: { kind: "none" },
            // A form-added app has no role table, so it cannot be `shared`.
            // Default to Entra: an internal Lennar tool is far more likely behind
            // the corporate sign-in than genuinely public, and defaulting to
            // "public" is the error that prompted this.
            auth_kind: AUTH_KINDS[(form && form.auth_kind)] && form.auth_kind !== "shared"
              ? form.auth_kind : "entra"
          }
        };
  }

  function parseAuthors(v) {
    if (Array.isArray(v)) return v.map(s => (s + "").trim()).filter(Boolean);
    return ((v || "") + "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function formatAuthors(authors) {
    const a = parseAuthors(authors);
    if (!a.length) return "—";
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + " and " + a[1];
    return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }

  function initialsOf(personName) {
    const parts = ((personName || "") + "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* ------------------------------------------------------------- role merging */

  // One row per person, one column per managed app. Roles are deliberately
  // independent per app (an editor in Takeoff Flow need not be one in Vendor
  // Assignments), so this merges without ever normalizing them.
  //
  // rolesByApp: { [slug]: [{ email, role, divisions }] }
  // Absence of a row means implicit viewer — everyone at the allowed domain can
  // read by default — which is a different state from an explicit "viewer".
  function mergeUsers(rolesByApp, apps, opts) {
    const options = opts || {};
    const managed = managedApps(apps);
    const byEmail = new Map();

    function row(email) {
      const e = normalizeEmail(email);
      if (!byEmail.has(e)) byEmail.set(e, { email: e, roles: {}, lastSignIn: null });
      return byEmail.get(e);
    }

    for (const app of managed) {
      for (const r of rolesByApp[app.slug] || []) {
        const rec = row(r.email);
        rec.roles[app.slug] = {
          role: r.role || options.defaultRole || "viewer",
          divisions: r.divisions || [],
          explicit: r.explicit !== false
        };
      }
    }

    for (const [email, meta] of Object.entries(options.lastSignIn || {})) {
      row(email).lastSignIn = meta;
    }

    // Fill implicit viewer for every managed app the person has no row in.
    for (const rec of byEmail.values()) {
      for (const app of managed) {
        if (!rec.roles[app.slug]) {
          rec.roles[app.slug] = {
            role: options.defaultRole || "viewer",
            divisions: [],
            explicit: false
          };
        }
      }
    }

    return sortEmails([...byEmail.values()]);
  }

  function isAdminAnywhere(userRow) {
    return Object.values((userRow && userRow.roles) || {}).some(r => r.role === "admin");
  }
  function adminSlugs(userRow) {
    return Object.entries((userRow && userRow.roles) || {})
      .filter(([, r]) => r.role === "admin")
      .map(([slug]) => slug)
      .sort(collator.compare);
  }
  function explicitRoleCount(userRow) {
    return Object.values((userRow && userRow.roles) || {}).filter(r => r.explicit).length;
  }

  function filterUsers(rows, query) {
    const q = ((query || "") + "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => {
      const hay = [r.email]
        .concat(Object.entries(r.roles).map(([s, v]) => s + " " + v.role + " " + (v.divisions || []).join(" ")))
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* ------------------------------------------------------------ provisioning */

  // Grants are explicit opt-in per app. Nothing is inherited from another
  // grant, and there is deliberately no "apply everywhere" shortcut.
  function buildGrantPlan(form, apps) {
    const managed = managedApps(apps);
    const grants = [];
    for (const app of managed) {
      const g = (form && form.grants && form.grants[app.slug]) || null;
      if (!g || !g.enabled) continue;
      const role = g.role || "viewer";
      if (app.roles && app.roles.length && app.roles.indexOf(role) === -1) {
        return { ok: false, error: 'Role "' + role + '" is not valid for ' + app.name + "." };
      }
      const scoped = (app.division_scoped_roles || []).indexOf(role) !== -1;
      grants.push({
        slug: app.slug,
        appName: app.name,
        roleTable: app.role_table,
        role,
        divisions: scoped ? (g.divisions || []) : [],
        tokenPool: app.token_pool || null,
        tokenRpc: app.token_rpc || null
      });
    }
    return { ok: true, grants: sortApps(grants.map(g => ({ ...g, name: g.appName }))) };
  }

  // Which token pools a set of grants requires. The password lives in the
  // shared auth.users row, so a person needs one link per *pool*, not per app.
  function poolsForGrants(grants) {
    const pools = new Set();
    for (const g of grants || []) if (g.tokenPool) pools.add(g.tokenPool);
    return [...pools].sort();
  }

  // Each mint RPC authorizes against a different role table, so pick one the
  // operator is actually an admin for. Hardcoding a single RPC would lock out
  // someone who is an admin in Takeoff Flow but not Vendor Assignments.
  function chooseMintRpc(pool, apps, operatorAdminSlugs) {
    const candidates = managedApps(apps).filter(
      a => a.token_pool === pool && a.token_rpc
    );
    const authorized = candidates.filter(
      a => (operatorAdminSlugs || []).indexOf(a.slug) !== -1
    );
    const chosen = authorized[0] || null;
    return chosen
      ? { ok: true, rpc: chosen.token_rpc, viaApp: chosen.name, viaSlug: chosen.slug }
      : {
          ok: false,
          error:
            "You are not an admin in any app that mints pool " + pool +
            " credentials, so this link cannot be generated."
        };
  }

  const BLUEPRINT_SLUG = "blueprint";

  // URLs carry a human-meaningful tag, not the internal pool letter — "cdb"
  // says which app's redeem function to use, whereas "b" would mean nothing to
  // anyone reading a link in a chat message. Pool A is the default and is left
  // untagged so every link generated before this existed stays valid.
  const POOL_TAG = { A: null, B: "cdb" };
  const TAG_POOL = { cdb: "B" };

  // Every credential link lands on Blueprint. Pool B is tagged so Blueprint
  // knows which redeem function to call; the existing /[#&]recover=([^&]+)/
  // parser in all three apps stops at the &, so the tag is backward compatible.
  function buildRecoverUrl(baseUrl, token, pool) {
    const base = (baseUrl || "").replace(/#.*$/, "");
    const withSlash = base.endsWith("/") ? base : base + "/";
    let url = withSlash + "#recover=" + encodeURIComponent(token);
    const tag = POOL_TAG[(pool || "A").toUpperCase()];
    if (tag) url += "&pool=" + tag;
    return url;
  }

  function parseRecoverHash(hash) {
    const h = (hash || "") + "";
    const m = h.match(/[#&]recover=([^&]+)/);
    if (!m) return null;
    const p = h.match(/[#&]pool=([^&]+)/);
    const tag = p ? decodeURIComponent(p[1]).toLowerCase() : null;
    // Unknown tags fall back to pool A rather than throwing: a malformed link
    // should fail at redemption with a clear message, not fail to parse.
    return { token: decodeURIComponent(m[1]), pool: (tag && TAG_POOL[tag]) || "A" };
  }

  /* ----------------------------------------------------------------- expiry */

  // Pool A stores expires_at. Pool B stores only created_at and hardcodes the
  // interval inside cdb_redeem_reset_token(), so it must be computed here.
  const POOL_B_TTL_DAYS = 14;

  function tokenExpiry(row, now) {
    const ref = now ? new Date(now) : new Date();
    if (!row) return null;
    let expires;
    if (row.expires_at) expires = new Date(row.expires_at);
    else if (row.created_at) {
      expires = new Date(row.created_at);
      expires.setDate(expires.getDate() + POOL_B_TTL_DAYS);
    } else return null;

    const ms = expires.getTime() - ref.getTime();
    return {
      expiresAt: expires,
      expired: ms <= 0,
      msRemaining: ms,
      hoursRemaining: Math.floor(ms / 3600000),
      computed: !row.expires_at
    };
  }

  function pendingInvites(rows, now) {
    return (rows || [])
      .filter(r => !r.used_at)
      .map(r => ({ ...r, expiry: tokenExpiry(r, now) }))
      .filter(r => r.expiry && !r.expiry.expired)
      .sort((a, b) => collator.compare(a.email, b.email));
  }

  /* ----------------------------------------------------------------- health */

  function assess(value, thresholds) {
    // thresholds: { warn, bad } — compared as "higher is worse".
    if (!thresholds) return "ok";
    if (thresholds.bad != null && value >= thresholds.bad) return "bad";
    if (thresholds.warn != null && value >= thresholds.warn) return "warn";
    return "ok";
  }

  function daysSince(iso, now) {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    const ref = now ? new Date(now).getTime() : Date.now();
    return Math.floor((ref - then) / 86400000);
  }

  function rollUp(checks) {
    const states = (checks || []).map(c => c.state);
    if (states.indexOf("bad") !== -1) return "bad";
    if (states.indexOf("warn") !== -1) return "warn";
    return "ok";
  }

  /* -------------------------------------------------------------- formatting */

  function relativeDay(iso, now) {
    const d = daysSince(iso, now);
    if (d == null) return "never";
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 30) return d + "d ago";
    if (d < 365) return Math.floor(d / 30) + "mo ago";
    return Math.floor(d / 365) + "y ago";
  }

  function escapeHtml(s) {
    return ((s == null ? "" : s) + "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  return {
    collator, byName, sortApps, sortEmails,
    isManaged, managedApps, activeApps, AUTH_KINDS, authKind, authMeta,
    EDITABLE_APP_FIELDS, pickEditable, rejectedFields, slugify, removalImpact,
    normalizeEmail, validateEmail, validateUrl, validateNewApp,
    parseAuthors, formatAuthors, initialsOf,
    mergeUsers, isAdminAnywhere, adminSlugs, explicitRoleCount, filterUsers,
    buildGrantPlan, poolsForGrants, chooseMintRpc,
    BLUEPRINT_SLUG, POOL_TAG, TAG_POOL, buildRecoverUrl, parseRecoverHash,
    POOL_B_TTL_DAYS, tokenExpiry, pendingInvites,
    assess, daysSince, rollUp, relativeDay, escapeHtml
  };
});
