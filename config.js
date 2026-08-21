/* ============================================================================
   Blueprint — config.js

   LOCAL DEV is the default. With SUPABASE_URL left blank, Blueprint runs against
   the in-memory mock in mock-db.js: every screen works, no network, no
   credentials, and nothing can touch production.

   To point at real Supabase, fill in the two values below. Nothing else changes
   — app.js talks to whichever client db.js hands it.
   ========================================================================== */
window.APP_CONFIG = {

  /* ---- backend ----------------------------------------------------------
     Live credentials, copied from the other three apps' config.js — all three
     already point at this same project, so one sign-in works across the suite.

     These being filled in does NOT mean local development hits production.
     db.js forces the in-memory mock whenever the page is served from localhost,
     so `node dev/serve.js` is always safe. To deliberately test against real
     Supabase from your machine, load http://localhost:8080/?live=1 — the header
     shows a LIVE warning when you do.                                        */
  SUPABASE_URL: "https://memhzqphludiruovuzwt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lbWh6cXBobHVkaXJ1b3Z1end0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTI3MjUsImV4cCI6MjA5OTc4ODcyNX0.hTJBtb3WtkgY66xqzZ22GT7V4VNllxPyb4C7qXRFFVI",

  /* ---- shared session -----------------------------------------------------
     MUST match the storageKey the sibling apps pass to createClient, character
     for character. All four sites are the same origin, so they share one
     localStorage; the key is what decides whether they share one *session*.

     Blueprint originally omitted this and got supabase-js's default key, which
     meant it kept a separate session from the other three: signing out here left
     them signed in, and "one sign-in covers every tool" was not actually true.
     Change this only by changing it everywhere at once.                        */
  AUTH_STORAGE_KEY: "lennar-vendor-portal-auth",

  // Sign-in is restricted to this domain.
  ALLOWED_DOMAIN: "@lennar.com",

  // Everyone at ALLOWED_DOMAIN without an explicit role row gets this.
  DEFAULT_ROLE: "viewer",

  /* ---- Data Intake ------------------------------------------------------
     Who sees the Data Intake tab. Intake is not an ordinary feature: one drop
     replaces whole divisions across three apps at once, so it is held to an
     explicit list of people rather than to a role. Blueprint admin is not
     enough — a Community-DB admin has no business republishing Takeoff Flow.

     Lower-case; addresses are compared normalised. Empty means nobody, which
     is the safe failure. Note this hides the tab and refuses the navigation;
     what a person may actually WRITE is still each app's own role table and
     its RLS policies — see intakeRoles() in db.js.                          */
  INTAKE_EMAILS: ["stephen.svedman@lennar.com"],

  /* ---- credential links ------------------------------------------------- */
  // Every invite and password-reset link lands here, including links minted from
  // inside the other three apps. In local mode this is overridden to the current
  // origin so links you generate are actually clickable while developing.
  // Capital B: the repository is named "Blueprint", and GitHub Pages paths are
  // case-sensitive. https://ssvedman.github.io/blueprint/ returns 404, which
  // would have silently broken every credential link.
  BLUEPRINT_URL: "https://ssvedman.github.io/Blueprint/",

  /* ---- app registry ------------------------------------------------------
     The live registry is the hub_apps table, so apps can be added at runtime
     without a deploy. This array is only a fallback for the first load if that
     table is missing or unreadable — it is never written to.

     Ordering is not configured anywhere: the UI sorts alphabetically by name
     with a punctuation-insensitive collator, so Community-DB precedes
     Community Map. There is deliberately no sort field to maintain.          */
  APPS_FALLBACK: [
    {
      slug: "Vendor-Portal", name: "Vendor Assignments",
      url: "https://ssvedman.github.io/Vendor-Portal/",
      description: "Division vendor assignments, coverage gaps and starts, imported from E1 exports.",
      icon_url: "https://ssvedman.github.io/Vendor-Portal/logo.svg",
      authors: ["Stephen Svedman"], active: true, auth_kind: "shared",
      role_table: "app_roles", list_rpc: "admin_list_users",
      token_rpc: "admin_add_or_reset", token_pool: "A",
      roles: ["admin", "editor", "viewer"], division_scoped_roles: ["editor"],
      division_source: { kind: "table", table: "app_divisions" }
    },
    {
      slug: "Takeoff-Flow", name: "Takeoff Flow",
      url: "https://ssvedman.github.io/Takeoff-Flow/",
      description: "Editable takeoff schedule with WORKDAY date math, pending budgets and change log.",
      icon_url: "https://ssvedman.github.io/Takeoff-Flow/logo.svg",
      authors: ["Stephen Svedman"], active: true, auth_kind: "shared",
      role_table: "tf_app_roles", list_rpc: "tf_admin_list_users",
      token_rpc: "tf_admin_add_or_reset", token_pool: "A",
      roles: ["admin", "editor", "purchasing", "viewer"],
      division_scoped_roles: ["editor", "purchasing"],
      division_source: { kind: "config", divisions: [
        { key: "tampa", label: "Tampa", code: "TPU" },
        { key: "orlando", label: "Orlando", code: "OLH" }
      ] }
    },
    {
      slug: "Community-DB", name: "Community-DB",
      url: "https://ssvedman.github.io/Community-DB/",
      description: "Community information sheets with draft/publish workflow, images and meeting notes.",
      icon_url: "https://ssvedman.github.io/Community-DB/logo.svg",
      authors: ["Denis Crepes", "Stephen Svedman"], active: true, auth_kind: "shared",
      role_table: "cdb_app_roles", list_rpc: "cdb_admin_list_users",
      token_rpc: "cdb_admin_add_or_reset", token_pool: "B",
      roles: ["admin", "editor", "viewer"], division_scoped_roles: [],
      division_source: { kind: "config", divisions: [
        { key: "orlando", label: "Orlando Division", code: "OLH" }
      ] }
    },
    {
      /* No sign-in, so no role table and no entry in Users — but Blueprint DOES
         see its data now. The document lives in map_data in this same database
         and Data Intake publishes it, so data_table is set and Health reports on
         it properly instead of shrugging "separate backend".

         It used to be a fork under another owner with its own storage. Both of
         those changed; the registry describing it as third-party was left behind. */
      slug: "lennar-map", name: "Community Map",
      url: "https://ssvedman.github.io/lennar-map/",
      description: "Orlando division community map — starts by month, trade-partner and vendor filters, utilities and municipality.",
      icon_url: "https://ssvedman.github.io/lennar-map/logo.svg",
      authors: ["Stephen Svedman"], active: true, auth_kind: "none",
      role_table: null, list_rpc: null, token_rpc: null, token_pool: null,
      roles: [], division_scoped_roles: [],
      division_source: { kind: "none" },
      data_table: "map_data"
    }
  ],

  /* ---- health thresholds -------------------------------------------------
     "Higher is worse" for each. Tunable without touching app code.           */
  HEALTH: {
    staleUploadDays:   { warn: 7,  bad: 21 },   // days since last data upload
    stalePublishDays:  { warn: 7,  bad: 30 },   // days since last CDB publish
    unpublishedDrafts: { warn: 1,  bad: 10 },
    needsReview:       { warn: 1,  bad: 10 },
    flaggedMissingPlans:  { warn: 1, bad: 25 },  // flow_rows.missing_plans non-empty
    missingTrenchDates:   { warn: 1, bad: 50 },  // no first_trench_date → no calc dates
    unassignedBudgetCols: { warn: 1, bad: 3  },
    neverSignedIn:     { warn: 1,  bad: 10 },
    pendingInvites:    { warn: 3,  bad: 10 }
  },

  /* ---- contact -----------------------------------------------------------
     Rendered as the footer "Send feedback" link. Kept here rather than in the
     markup so there is one place to change or clear it — this repo is public, so
     any real address in it is a deliberate choice. Set to "" to hide the link.

     This one is deliberate: it is the maintainer's own work address, it is how
     people report problems, and the three sibling apps already publish it in
     their footers. The hygiene scan allows it here and only here — a real address
     in a test fixture is still a failure. */
  FEEDBACK_EMAIL: "stephen.svedman@lennar.com",

  // Local mock only: which account the dev "Sign in" button assumes.
  DEV_USER: "avery.stone@lennar.com"
};
