-- ============================================================================
--  Blueprint — the `app` schema
--
--  The read-only analytics layer behind Blueprint's Query console: a schema, its
--  metadata tables, the domain and conformed views over the four apps' tables,
--  and the functions the console calls.
--
--  Run in Supabase Studio > SQL Editor. Safe to re-run: everything uses
--  IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
--  WHY THIS FILE EXISTS
--  This schema was built across a dozen loose claude-*.sql files that lived
--  beside the repositories rather than in one, several superseding each other —
--  three versions of run_select, three of f_coverage_risk. They were applied to
--  the database and never folded back, so the repository stopped describing the
--  database.
--
--  That is not a tidiness complaint. One of those files, claude-fix-map-public.sql,
--  wrapped map_public's `people` column in an @lennar.com check. It was applied,
--  it was never committed, and for three days every community on the public map
--  read "Not yet assigned" while the table held all 54 contacts. Nothing errored.
--  The repository said one thing and the database did another, and there was no
--  third place to check. map_supabase_setup.sql now asserts that contacts pass
--  through; this file exists so the rest of the schema cannot drift the same way.
--
--  ORDER MATTERS. Objects are defined before they are granted on, and views
--  before the functions that read them. Sections are numbered accordingly.
--
--  Consolidated 2026-09-14 from, in order:
--    claude-data-layer.sql      schema, meta tables, policies, describe_schema
--    claude-audit-fix.sql       v_security_audit (replacing the data-layer copy,
--                               which over-reported — see its note below)
--    claude-domain-views.sql    v_division, v_community, v_start, v_vendor_*,
--                               vendor_alias, f_vendor_share
--    claude-conformed-views.sql v_cis, v_flow, v_plan*, v_budget*, v_cost_code,
--                               v_takeoff_change, v_community_xwalk
--    claude-run-select-v2.sql   run_select  (superseded two earlier versions)
--    claude-coverage-risk-v3.sql f_coverage_risk (superseded two earlier)
--    claude-console-grants.sql  grants, default privileges, exposed-schema note
-- ============================================================================

-- ============================================================================
-- Claude data-access layer -- Lennar Supabase project memhzqphludiruovuzwt
--
-- ONE FILE. Run it top to bottom in the Supabase SQL editor. No phases, no
-- decisions, no sections to skip. It is idempotent -- running it twice is
-- harmless -- and it is entirely additive: it creates nothing outside the new
-- `app` schema, alters no existing table, grants nothing to `anon`, and
-- revokes nothing your live apps depend on.
--
-- Everything here is SECURITY INVOKER. Each object executes as the signed-in
-- user, so the RLS policies you already have are evaluated unchanged. Claude
-- cannot read one row more than your own account can read. There is no
-- dynamic SQL, no eval endpoint, and no new database role.
--
-- The last statement prints a security audit of your whole project. Read it.
--
-- WHAT THIS FILE DOES NOT DO, and why: it does not create or reshape any
-- domain tables. Your project has 28 tables across at least six apps
-- (division_data, pdb_*, cdb_*, tf_*, flow_rows, map_data, hub_apps...) whose
-- columns this layer does not presume to know. A file that blindly created
-- dim_/fact_ tables would stand up an empty parallel schema next to the real
-- data, which is worse than nothing. describe_schema() below reports what is
-- actually there; the domain views in section 6 are written against that.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Namespace
-- ----------------------------------------------------------------------------

create schema if not exists app;
grant usage on schema app to authenticated;
revoke all on schema app from anon;


-- ----------------------------------------------------------------------------
-- 2. The data dictionary
--
-- This is the piece that makes the layer general rather than vendor-specific.
-- Claude reads these three tables first and then understands a domain it has
-- never seen -- grain, units, caveats -- without you briefing it each time.
-- They hold descriptions only, never row data.
-- ----------------------------------------------------------------------------

create table if not exists app.meta_table (
  table_name  text primary key,
  domain      text,          -- 'vendor assignments', 'plan costs', 'takeoffs'
  grain       text,          -- 'one row per community per month'
  description text,
  owner_email text,
  refresh     text           -- 'nightly', 'on upload', 'manual'
);

create table if not exists app.meta_column (
  table_name  text not null,
  column_name text not null,
  description text,
  units       text,
  notes       text,          -- caveats, known bad values, gotchas
  primary key (table_name, column_name)
);

-- Metric definitions. This exists because "percentage of work allocated" has
-- at least two defensible readings -- share of TOTAL division starts, or share
-- WITHIN a category -- and when you asked, I picked the first because that is
-- what your portal displays. I guessed. Pinning definitions here means a
-- number cannot quietly change meaning between conversations.
create table if not exists app.meta_metric (
  metric_key  text primary key,
  label       text not null,
  definition  text not null,
  numerator   text,
  denominator text,
  sql_hint    text,
  owner_email text
);

insert into app.meta_metric
  (metric_key, label, definition, numerator, denominator)
values (
  'vendor_share_of_division_starts',
  'Vendor share of division starts',
  'Of all projected starts in a division over a date range, the share in '
  || 'communities where the vendor holds the named trade category. Matches the '
  || 'Vendor Portal Full Matrix. Caveat: scopes with very different footprints '
  || 'share one denominator, so a foundation scope and a trim scope are not '
  || 'directly comparable. Builders FirstSource trades under two vendor '
  || 'numbers (11798425 and 7846762) and must be rolled up to one company.',
  'starts in communities assigned to the vendor for that category',
  'all starts in the division over the same range'
)
on conflict (metric_key) do nothing;

grant select on app.meta_table, app.meta_column, app.meta_metric
  to authenticated;


-- 2b. RLS on the three dictionary tables.
--
-- The SQL editor's linter flags any CREATE TABLE without RLS, and it is right
-- to. Real exposure here is nil today -- PostgREST only serves the schemas in
-- Settings > API > Exposed schemas, and `app` is not one of them -- but these
-- tables end up holding a map of every table and column across all six of
-- your apps, so they should not depend on that setting staying unchanged.
--
-- Do NOT take the editor's "Run and enable RLS" button for these. It turns RLS
-- on with zero policies, which is deny-all. You would still see rows in the
-- SQL editor, because you connect as the owner and bypass RLS -- but
-- app.describe_schema() executes as `authenticated`, would match no policy,
-- and would silently return an empty dictionary. The explicit policies below
-- are what you want instead.

alter table app.meta_table  enable row level security;
alter table app.meta_column enable row level security;
alter table app.meta_metric enable row level security;

-- Read: any signed-in user. Descriptions only -- no row data from any domain.
--
-- Created only if absent, rather than dropped and recreated. A DROP POLICY
-- would make this file trip the editor's "destructive operations" warning on
-- every run, and there is no reason to make a routine re-run look dangerous.
do $$
begin
  if not exists (select 1 from pg_policy
                 where polname = 'meta_table_read'
                   and polrelid = 'app.meta_table'::regclass) then
    create policy meta_table_read on app.meta_table
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policy
                 where polname = 'meta_column_read'
                   and polrelid = 'app.meta_column'::regclass) then
    create policy meta_column_read on app.meta_column
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policy
                 where polname = 'meta_metric_read'
                   and polrelid = 'app.meta_metric'::regclass) then
    create policy meta_metric_read on app.meta_metric
      for select to authenticated using (true);
  end if;
end
$$;

-- Write: deliberately no INSERT/UPDATE/DELETE policy on any of the three.
-- With RLS enabled and no write policy, writes are denied to `anon` and
-- `authenticated` alike. Only the table owner and service_role can change
-- them -- which means you, editing descriptions in the SQL editor. That is
-- the right bound while your admin/editor/viewer map still lives client-side
-- in config.js and cannot be trusted as an authorization check.
--
-- Note RLS is enabled but not FORCED, so your owner connection keeps writing
-- normally. Forcing it would lock you out of your own dictionary.


-- ----------------------------------------------------------------------------
-- 3. Auto-seed the dictionary skeleton
--
-- Creates a stub row for every table and column that exists right now, so you
-- fill in descriptions rather than typing structure. Safe to re-run after you
-- add tables: existing descriptions are never overwritten.
-- ----------------------------------------------------------------------------

insert into app.meta_table (table_name, description)
select t.table_name, null
from   information_schema.tables t
where  t.table_schema = 'public'
  and  t.table_type   = 'BASE TABLE'
on conflict (table_name) do nothing;

insert into app.meta_column (table_name, column_name, notes)
select c.table_name,
       c.column_name,
       'auto-discovered: ' || c.data_type
from   information_schema.columns c
join   information_schema.tables t
         on  t.table_schema = c.table_schema
         and t.table_name   = c.table_name
         and t.table_type   = 'BASE TABLE'
where  c.table_schema = 'public'
on conflict (table_name, column_name) do nothing;


-- ----------------------------------------------------------------------------
-- 4. Schema introspection
--
-- One call returns your dictionary plus the live physical schema, including
-- primary and foreign keys so Claude can see which tables join cleanly.
-- information_schema already filters to objects the caller may see.
-- ----------------------------------------------------------------------------

create or replace function app.describe_schema()
returns jsonb
language sql
security invoker
set search_path = pg_catalog, public, app, information_schema
stable
as $$
  select jsonb_build_object(
    'generated_at', now(),

    'dictionary_tables', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.table_name), '[]'::jsonb)
      from app.meta_table t),

    'dictionary_columns', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.table_name, c.column_name),
                      '[]'::jsonb)
      from app.meta_column c),

    'metrics', (
      select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
      from app.meta_metric m),

    'tables', (
      select coalesce(jsonb_agg(x order by x.table_name), '[]'::jsonb)
      from (
        select cl.relname as table_name,
               st.n_live_tup as approx_rows,
               cl.relrowsecurity as rls_enabled,
               (select coalesce(jsonb_agg(jsonb_build_object(
                          'column', co.column_name,
                          'type',   co.data_type,
                          'nullable', co.is_nullable)
                        order by co.ordinal_position), '[]'::jsonb)
                from information_schema.columns co
                where co.table_schema = 'public'
                  and co.table_name = cl.relname) as columns
        from   pg_class cl
        join   pg_namespace n on n.oid = cl.relnamespace
        left   join pg_stat_user_tables st on st.relid = cl.oid
        where  n.nspname = 'public' and cl.relkind = 'r'
      ) x),

    'foreign_keys', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'from_table',  tc.table_name,
               'from_column', kcu.column_name,
               'to_table',    ccu.table_name,
               'to_column',   ccu.column_name)), '[]'::jsonb)
      from   information_schema.table_constraints tc
      join   information_schema.key_column_usage kcu
               on kcu.constraint_name = tc.constraint_name
      join   information_schema.constraint_column_usage ccu
               on ccu.constraint_name = tc.constraint_name
      where  tc.table_schema = 'public'
        and  tc.constraint_type = 'FOREIGN KEY'),

    'views', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'view', cl.relname,
               'security_invoker',
                 coalesce((select o from unnest(cl.reloptions) o
                           where o like 'security_invoker%'), 'MISSING'))),
             '[]'::jsonb)
      from   pg_class cl
      join   pg_namespace n on n.oid = cl.relnamespace
      where  n.nspname = 'public' and cl.relkind = 'v')
  );
$$;

revoke all on function app.describe_schema() from public, anon;
grant execute on function app.describe_schema() to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Standing security audit
--
-- `select * from app.v_security_audit;` any time. Six checks, each emitting
-- one row per problem found. An empty result means everything passed.
--
-- This REPORTS rather than fixes. Auto-revoking privileges could break your
-- live apps -- your password-reset flow, for one, may legitimately need
-- specific grants -- so nothing here changes permissions. You decide.
-- ----------------------------------------------------------------------------


-- The audit view below replaces the one this file originally carried, which
-- over-reported: it appended "Role check is client-side only" to every write
-- policy regardless of predicate, so policies carrying a real server-side
-- function like tf_can_edit(division) were flagged as false positives; and it
-- read polqual for INSERT policies, which have no USING clause, printing
-- "USING true" for rows whose actual WITH CHECK it never examined. This version
-- separates "no predicate at all" from "has a predicate" and quotes the real
-- expression instead of asserting a conclusion.

create or replace view app.v_security_audit
with (security_invoker = true) as

-- ---- 1. RLS switched off entirely --------------------------------------
select 'CRITICAL'::text as severity,
       'rls_disabled'::text as check_name,
       (n.nspname || '.' || c.relname)::text as object_name,
       'Table has RLS disabled. Any holder of the anon or authenticated key '
       || 'reads and writes every row.' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

union all

-- ---- 2. Views running with owner rights --------------------------------
select 'CRITICAL',
       'view_bypasses_rls',
       (n.nspname || '.' || c.relname)::text,
       'View lacks security_invoker=true, so it runs with owner rights and '
       || 'bypasses RLS on its base tables. Deliberate only if the view is a '
       || 'curated projection intended for wider access than the base table.'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and coalesce((select option_value
                from pg_options_to_table(c.reloptions)
                where option_name = 'security_invoker'), 'false') <> 'true'

union all

-- ---- 3. Write policies with NO predicate -------------------------------
--      polcmd: a=INSERT w=UPDATE d=DELETE *=ALL
--      For INSERT the expression is polwithcheck; for the rest, polqual.
--      A policy is "open" only when its governing expression is absent or
--      literally true.
select 'HIGH',
       'write_policy_no_predicate',
       (c.relname || ' / ' || p.polname)::text,
       'Policy for '
       || case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                        when 'd' then 'DELETE' when '*' then 'ALL' end
       || ' to ' || coalesce(
            (select string_agg(r.rolname, ',') from pg_roles r
             where r.oid = any (p.polroles)), 'public')
       || ' has no restricting expression (it is absent or literally true). '
       || 'Any caller in that role qualifies. If the intended gate is a role '
       || 'check, it is not being enforced in the database.'
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and p.polcmd in ('a', 'w', 'd', '*')
  and coalesce(
        nullif(trim(pg_get_expr(
          case when p.polcmd = 'a' then p.polwithcheck else p.polqual end,
          p.polrelid)), ''), 'true') = 'true'

union all

-- ---- 4. Write policies WITH a predicate -- informational, quote it -----
select 'INFO',
       'write_policy_has_predicate',
       (c.relname || ' / ' || p.polname)::text,
       'Enforced in-database by: '
       || pg_get_expr(case when p.polcmd = 'a' then p.polwithcheck
                           else p.polqual end, p.polrelid)
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and p.polcmd in ('a', 'w', 'd', '*')
  and coalesce(
        nullif(trim(pg_get_expr(
          case when p.polcmd = 'a' then p.polwithcheck else p.polqual end,
          p.polrelid)), ''), 'true') <> 'true'

union all

-- ---- 5. anon privileges ------------------------------------------------
select 'HIGH',
       'anon_has_privilege',
       (n.nspname || '.' || c.relname)::text,
       'anon holds ' || a.privilege_type
       || '. The anon key is published in config.js, so this is public access.'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and r.rolname = 'anon'

union all

-- ---- 6. SECURITY DEFINER functions -------------------------------------
select 'REVIEW',
       'security_definer_function',
       (n.nspname || '.' || p.proname)::text,
       'SECURITY DEFINER, executes as ' || pg_get_userbyid(p.proowner)
       || '. Confirm the body checks the CALLER''S authorisation before acting.'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef

union all

-- ---- 7. RLS on, zero policies = deny-all -------------------------------
select 'INFO',
       'rls_on_no_policies',
       (n.nspname || '.' || c.relname)::text,
       'RLS enabled with zero policies: deny-all to anon and authenticated. '
       || 'Correct for token tables; a mistake anywhere else.'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid);


grant select on app.v_security_audit to authenticated;
revoke all on app.v_security_audit from anon;


-- ----------------------------------------------------------------------------
-- 6. Results. Both statements below return output -- read them.
-- ----------------------------------------------------------------------------

select severity, check_name, object_name, finding
from   app.v_security_audit
order  by case severity when 'CRITICAL' then 1 when 'HIGH' then 2
                        when 'REVIEW'   then 3 else 4 end,
         check_name, object_name;



-- ============================================================================
--  Domain views — one row per real-world thing, over the app tables
-- ============================================================================
-- ============================================================================
-- claude-domain-views.sql
-- Domain layer over division_data.payload (vendor assignments + starts)
--
-- Run in one shot. Safe to re-run (idempotent).
--
-- SAFETY PROPERTIES (same contract as claude-data-layer.sql):
--   * Additive only. Creates nothing outside the `app` schema.
--   * Every view is SECURITY INVOKER -- they run with YOUR rights and respect
--     RLS on public.division_data. They cannot leak rows you can't already see.
--   * No DROP of anything you own. No grants to `anon`. No dynamic SQL.
--   * The one new table (app.vendor_alias) gets RLS + an explicit read policy
--     and NO write policy, so only owner/service_role can modify it.
--
-- WHY THIS EXISTS
--   public.division_data holds 2 rows -- one per division -- and each row's
--   `payload` is a single JSONB document containing the entire dataset:
--
--     payload.key              text     'orlando'
--     payload.code             text     'OLH'
--     payload.division         text     'Orlando'
--     payload.categories       text[]   255 trade categories
--     payload.communities      [{id, name, homesites}]            532
--     payload.vendors          [{name, supplierCode, tradeCode,
--                                category, assigned[], billCode,
--                                total2026, totalCommunities}]     2023
--     payload.startRecords     [{date, kind, community}]          6813
--     payload.startsDateRange  {min, max}
--
--   These views shred that document into relational shape so it can be
--   queried and joined normally.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. VENDOR NAME ALIASES
--
--    The same legal vendor appears under multiple spellings AND multiple
--    supplier codes. Verified in the Orlando payload:
--
--      'Builders First Source Florida'   -> 11798425, 7846762
--      'Builders Firstsource-Florida L'  -> 9239552
--
--    26 vendors carry more than one supplierCode, so supplier_code is NOT a
--    usable vendor key. Roll up on canonical_name instead.
--
--    This is a real table -- add rows as you find more variants.
-- ----------------------------------------------------------------------------
create table if not exists app.vendor_alias (
  raw_name        text primary key,
  canonical_name  text not null,
  note            text,
  created_at      timestamptz not null default now()
);

alter table app.vendor_alias enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'app.vendor_alias'::regclass
      and polname  = 'vendor_alias_read'
  ) then
    create policy vendor_alias_read on app.vendor_alias
      for select to authenticated using (true);
  end if;
end $$;

insert into app.vendor_alias (raw_name, canonical_name, note) values
  ('Builders First Source Florida',  'Builders FirstSource', 'codes 11798425 + 7846762'),
  ('Builders Firstsource-Florida L', 'Builders FirstSource', 'code 9239552'),
  ('Builders FirstSource Florida',   'Builders FirstSource', 'defensive: spacing variant'),
  ('Gleckler & Sons Construction',   'Gleckler & Sons',      'code 20940770')
on conflict (raw_name) do nothing;


-- ----------------------------------------------------------------------------
-- 2. DIVISION
-- ----------------------------------------------------------------------------
create or replace view app.v_division
with (security_invoker = true) as
select
  d.key                                        as division_key,
  d.payload ->> 'code'                         as division_code,
  d.payload ->> 'division'                     as division_label,
  (d.payload -> 'startsDateRange' ->> 'min')::date as starts_min,
  (d.payload -> 'startsDateRange' ->> 'max')::date as starts_max,
  jsonb_array_length(coalesce(d.payload -> 'communities',  '[]'::jsonb)) as community_count,
  jsonb_array_length(coalesce(d.payload -> 'vendors',      '[]'::jsonb)) as vendor_row_count,
  jsonb_array_length(coalesce(d.payload -> 'startRecords', '[]'::jsonb)) as start_record_count,
  d.updated_at,
  d.updated_by
from public.division_data d
where jsonb_typeof(d.payload) = 'object';


-- ----------------------------------------------------------------------------
-- 3. COMMUNITY          (name is unique and is the real join key --
--                        verified: 0 orphans in either direction)
-- ----------------------------------------------------------------------------
create or replace view app.v_community
with (security_invoker = true) as
select
  d.key                as division_key,
  c ->> 'id'           as community_id,
  c ->> 'name'         as community_name,
  c ->> 'homesites'    as homesites      -- currently null for all 532 rows
from public.division_data d
cross join lateral jsonb_array_elements(d.payload -> 'communities') c
where jsonb_typeof(d.payload -> 'communities') = 'array';


-- ----------------------------------------------------------------------------
-- 4. TRADE CATEGORY     (category -> tradeCode is 1:1; verified no conflicts)
-- ----------------------------------------------------------------------------
create or replace view app.v_trade_category
with (security_invoker = true) as
select distinct
  d.key                as division_key,
  v ->> 'category'     as category,
  v ->> 'tradeCode'    as trade_code
from public.division_data d
cross join lateral jsonb_array_elements(d.payload -> 'vendors') v
where jsonb_typeof(d.payload -> 'vendors') = 'array';


-- ----------------------------------------------------------------------------
-- 5. VENDOR ASSIGNMENT  -- the core fact. One row per
--                          (division, vendor, category, community).
--
--    `assigned` is exploded here. 2,023 vendor rows become ~56,500
--    assignment rows for Orlando.
-- ----------------------------------------------------------------------------
create or replace view app.v_vendor_assignment
with (security_invoker = true) as
select
  d.key                                           as division_key,
  coalesce(a.canonical_name, v ->> 'name')        as vendor_name,
  v ->> 'name'                                    as vendor_name_raw,
  v ->> 'supplierCode'                            as supplier_code,
  v ->> 'category'                                as category,
  v ->> 'tradeCode'                               as trade_code,
  cm.value                                        as community_name
from public.division_data d
cross join lateral jsonb_array_elements(d.payload -> 'vendors') v
cross join lateral jsonb_array_elements_text(v -> 'assigned') cm(value)
left join app.vendor_alias a on a.raw_name = v ->> 'name'
where jsonb_typeof(d.payload -> 'vendors') = 'array';


-- ----------------------------------------------------------------------------
-- 6. STARTS             kind is 'Actual' or 'Projected'
-- ----------------------------------------------------------------------------
create or replace view app.v_start
with (security_invoker = true) as
select
  d.key                     as division_key,
  (s ->> 'date')::date      as start_date,
  s ->> 'kind'              as start_kind,
  s ->> 'community'         as community_name
from public.division_data d
cross join lateral jsonb_array_elements(d.payload -> 'startRecords') s
where jsonb_typeof(d.payload -> 'startRecords') = 'array';


-- ----------------------------------------------------------------------------
-- 7. ALLOCATION FUNCTION
--
--    Share of starts in a window that fall in communities assigned to a
--    vendor for a given trade category.
--
--    DENOMINATOR NOTE -- this is the subtle part:
--    734 of 56,501 (category, community) pairs in Orlando have MORE THAN ONE
--    vendor assigned. Summing per-vendor starts to get a category total
--    therefore double-counts those communities. This function uses the
--    count of starts in DISTINCT communities that have any vendor in the
--    category, which is the correct denominator. As a result the per-vendor
--    percentages within a category may sum to slightly more than 100% where
--    coverage overlaps -- that overlap is real, not an arithmetic error.
--
--    Defaults: today through today + 12 months, all kinds, all divisions.
-- ----------------------------------------------------------------------------
create or replace function app.f_vendor_share(
  p_from     date default current_date,
  p_to       date default (current_date + interval '12 months')::date,
  p_kind     text default null,     -- 'Actual' | 'Projected' | null = both
  p_division text default null,     -- 'orlando' | 'tampa'     | null = both
  p_category text default null      -- exact category, or null = all
)
returns table (
  division_key    text,
  category        text,
  trade_code      text,
  vendor_name     text,
  vendor_starts   bigint,
  category_starts bigint,
  pct_of_category numeric
)
language sql
stable
security invoker
as $$
  with starts as (
    select s.division_key, s.community_name, count(*)::bigint as n
    from app.v_start s
    where s.start_date between p_from and p_to
      and (p_kind is null or s.start_kind = p_kind)
      and (p_division is null or s.division_key = p_division)
    group by 1, 2
  ),
  asg as (
    select distinct
      va.division_key, va.category, va.trade_code,
      va.vendor_name, va.community_name
    from app.v_vendor_assignment va
    where (p_division is null or va.division_key = p_division)
      and (p_category is null or va.category     = p_category)
  ),
  per_vendor as (
    select a.division_key, a.category, a.trade_code, a.vendor_name,
           coalesce(sum(st.n), 0)::bigint as vendor_starts
    from asg a
    left join starts st
      on st.division_key   = a.division_key
     and st.community_name = a.community_name
    group by 1, 2, 3, 4
  ),
  per_category as (
    select d.division_key, d.category,
           coalesce(sum(st.n), 0)::bigint as category_starts
    from (select distinct division_key, category, community_name from asg) d
    left join starts st
      on st.division_key   = d.division_key
     and st.community_name = d.community_name
    group by 1, 2
  )
  select
    pv.division_key, pv.category, pv.trade_code, pv.vendor_name,
    pv.vendor_starts, pc.category_starts,
    case when pc.category_starts > 0
         then round(100.0 * pv.vendor_starts / pc.category_starts, 1)
         else 0 end
  from per_vendor pv
  join per_category pc
    on pc.division_key = pv.division_key
   and pc.category     = pv.category
  where pv.vendor_starts > 0
  order by pv.division_key, pv.category, pv.vendor_starts desc;
$$;


-- ----------------------------------------------------------------------------
-- 8. UPDATE THE METRIC DEFINITION with what we now know
--
--    app.meta_metric is our own documentation table in the `app` schema, so
--    these ADD COLUMN IF NOT EXISTS lines are additive and safe -- they just
--    guarantee the columns below exist regardless of how the table was first
--    created. They touch nothing in `public`.
-- ----------------------------------------------------------------------------
alter table app.meta_metric add column if not exists label      text;
alter table app.meta_metric add column if not exists definition text;
alter table app.meta_metric add column if not exists sql_hint   text;
alter table app.meta_metric add column if not exists caveats    text;

-- guarantees the ON CONFLICT target below resolves, whatever the original
-- key definition was (harmless/redundant if metric_key is already the PK)
create unique index if not exists meta_metric_key_uq
  on app.meta_metric (metric_key);

insert into app.meta_metric (metric_key, label, definition, sql_hint, caveats)
values (
  'vendor_share_of_division_starts',
  'Vendor share of division starts',
  'Starts in the window landing in communities assigned to the vendor for a '
  || 'trade category, divided by starts in all communities having any vendor '
  || 'in that category.',
  'select * from app.f_vendor_share(''2026-09-11'', ''2027-09-11'', null, ''orlando'');',
  'Vendors appear under multiple supplier codes and multiple name spellings; '
  || 'roll up on app.vendor_alias.canonical_name, never on supplier_code. '
  || '734 of 56501 category-community pairs have 2-3 vendors, so shares within '
  || 'a category can exceed 100% where coverage overlaps.'
)
on conflict (metric_key) do update
  set definition = excluded.definition,
      sql_hint   = excluded.sql_hint,
      caveats    = excluded.caveats;


-- ----------------------------------------------------------------------------
-- 9. VERIFY -- should reproduce the trim/door table
-- ----------------------------------------------------------------------------
select category, vendor_name, vendor_starts, pct_of_category, category_starts
from app.f_vendor_share(current_date, (current_date + interval '12 months')::date,
                        null, 'orlando')
where category in ('Trim Material', 'Trim Labor', 'Trim Package',
                   'Trim Turnkey', 'Exterior Doors')
  and vendor_name in ('Gleckler & Sons', 'Builders FirstSource')
order by category, vendor_name;



-- ============================================================================
--  Conformed views — Takeoff Flow, Community-DB and plan data
-- ============================================================================
-- ============================================================================
-- claude-conformed-views.sql
--
-- Conformed-key views over the relational domains, so flow_rows, pdb_*,
-- takeoff_changes and cdb_cis can be joined to each other.
--
-- DDL only. No verification statements -- I verify from the console.
-- Additive, SECURITY INVOKER, `app` schema only. Nothing in public changes.
--
-- ----------------------------------------------------------------------------
-- WHAT THE KEY PROFILING ACTUALLY SHOWED (measured, not assumed)
--
-- division -- ALREADY CONFORMED. Every table uses lowercase 'orlando' /
--   'tampa'. The 'TPU' / 'OLH' codes I expected to find appear nowhere
--   outside app_divisions.code. No normalisation needed; lower(trim()) is
--   applied defensively only.
--
-- comm_num -- CLEAN KEY. flow_rows.community_num and pdb_*.comm_num are both
--   exactly 11 characters, all digits, in every row. Stripping leading zeros
--   changes the overlap not at all (87 either way), confirming there is no
--   padding mismatch. The apparent gap is coverage, not format:
--       flow_rows        251 distinct communities
--       pdb_plan_costs   105 distinct
--       overlap           87   ( = 83% of the pdb side )
--   pdb simply covers fewer communities. This is the community join.
--
-- community NAME -- NOT A KEY. Only 8 names intersect between
--   flow_rows.community_name and pdb_plan_costs.community. The two systems
--   spell communities differently. Names are carried through for display and
--   deliberately never joined on.
--   (Note this is the opposite of the vendor-assignment domain inside
--   division_data, where name IS the reliable key and comm id is not used.
--   Two domains, two different natural keys -- worth remembering.)
--
-- plan_no -- USABLE, PARTIAL. flow_rows.plan 279 distinct, pdb_plans.plan_no
--   263, overlap 160 after upper(trim()). Both are 4-6 chars and mix numeric
--   and alphanumeric forms ('1372', '05GA', '1-PLEX'), so the formats are
--   compatible; the non-overlap is genuinely different plan catalogues, not
--   a normalisation failure. Expect ~60% join coverage and do not treat a
--   miss as an error.
--
-- elevation -- NEEDS CASE FOLDING. flow_rows.elevation contains both 'a' and
--   'A' as separate values (75 distinct vs 56 in pdb_plan_costs.elev).
--   upper(trim()) is required here or the join silently drops rows.
-- ----------------------------------------------------------------------------

-- Canonical column names added by every view below:
--     division_key   text   lowercase 'orlando' | 'tampa'
--     comm_no        text   11-digit community number  (join key)
--     plan_no        text   upper-cased plan            (join key)
--     elevation_key  text   upper-cased elevation       (join key)
-- Each view is `select t.*, <canonical keys>` so no existing column is lost
-- and nothing breaks if the underlying table gains columns later.


-- ---- flow_rows -------------------------------------------------------------
create or replace view app.v_flow
with (security_invoker = true) as
select f.*,
       lower(trim(f.division))       as division_key,
       nullif(trim(f.community_num), '') as comm_no,
       upper(nullif(trim(f.plan), ''))   as plan_no_key,
       upper(nullif(trim(f.elevation), '')) as elevation_key
from public.flow_rows f;


-- ---- pdb_plans -------------------------------------------------------------
create or replace view app.v_plan
with (security_invoker = true) as
select p.*,
       lower(trim(p.division))            as division_key,
       upper(nullif(trim(p.plan_no), '')) as plan_no_key
from public.pdb_plans p;


-- ---- pdb_plan_costs --------------------------------------------------------
create or replace view app.v_plan_cost
with (security_invoker = true) as
select c.*,
       lower(trim(c.division))              as division_key,
       nullif(trim(c.comm_num), '')         as comm_no,
       upper(nullif(trim(c.plan_no), ''))   as plan_no_key,
       upper(nullif(trim(c.elev), ''))      as elevation_key
from public.pdb_plan_costs c;


-- ---- pdb_cost_codes  (152,191 rows -- filter by division_key/comm_no) ------
create or replace view app.v_cost_code
with (security_invoker = true) as
select c.*,
       lower(trim(c.division))              as division_key,
       nullif(trim(c.comm_num), '')         as comm_no,
       upper(nullif(trim(c.plan_no), ''))   as plan_no_key,
       upper(nullif(trim(c.elev), ''))      as elevation_key
from public.pdb_cost_codes c;


-- ---- pdb_plan_options ------------------------------------------------------
create or replace view app.v_plan_option
with (security_invoker = true) as
select o.*,
       lower(trim(o.division))              as division_key,
       nullif(trim(o.comm_num), '')         as comm_no,
       upper(nullif(trim(o.plan_no), ''))   as plan_no_key,
       upper(nullif(trim(o.elev), ''))      as elevation_key
from public.pdb_plan_options o;


-- ---- takeoff_changes -------------------------------------------------------
create or replace view app.v_takeoff_change
with (security_invoker = true) as
select t.*,
       lower(trim(t.division))              as division_key,
       upper(nullif(trim(t.plan), ''))      as plan_no_key,
       upper(nullif(trim(t.elev), ''))      as elevation_key
from public.takeoff_changes t;


-- ---- cdb_cis ---------------------------------------------------------------
create or replace view app.v_cis
with (security_invoker = true) as
select c.*,
       lower(trim(c.division)) as division_key
from public.cdb_cis c;


-- ---- pending budgets, resolved to a division -------------------------------
-- pending_budget_checks / _status carry no division of their own; they reach
-- it through flow_rows via the only real foreign keys in the database.
-- This view does that join once so callers do not have to rediscover it.
create or replace view app.v_budget_status
with (security_invoker = true) as
select s.*,
       lower(trim(f.division))              as division_key,
       nullif(trim(f.community_num), '')    as comm_no,
       f.community_name,
       upper(nullif(trim(f.plan), ''))      as plan_no_key
from public.pending_budget_status s
join public.flow_rows f on f.id = s.flow_id;

create or replace view app.v_budget_check
with (security_invoker = true) as
select k.*,
       lower(trim(f.division))              as division_key,
       nullif(trim(f.community_num), '')    as comm_no,
       f.community_name,
       upper(nullif(trim(f.plan), ''))      as plan_no_key
from public.pending_budget_checks k
join public.flow_rows f on f.id = k.flow_id;


-- ---- community crosswalk ---------------------------------------------------
-- Because the two systems spell communities differently (8 names in common),
-- this is the place to see both spellings side by side for one comm_no, and
-- the fastest way to sanity-check a join that returns less than expected.
create or replace view app.v_community_xwalk
with (security_invoker = true) as
with fl as (
  select distinct lower(trim(division)) as division_key,
         nullif(trim(community_num), '') as comm_no,
         community_name                  as flow_name
  from public.flow_rows
  where nullif(trim(community_num), '') is not null
),
pc as (
  select distinct lower(trim(division)) as division_key,
         nullif(trim(comm_num), '')     as comm_no,
         community                      as pdb_name
  from public.pdb_plan_costs
  where nullif(trim(comm_num), '') is not null
)
select coalesce(fl.division_key, pc.division_key) as division_key,
       coalesce(fl.comm_no, pc.comm_no)           as comm_no,
       fl.flow_name,
       pc.pdb_name,
       case when fl.comm_no is not null and pc.comm_no is not null then 'both'
            when fl.comm_no is not null then 'flow_only'
            else 'pdb_only' end                   as present_in
from fl
full outer join pc
  on  pc.division_key = fl.division_key
  and pc.comm_no      = fl.comm_no;


grant select on
  app.v_flow, app.v_plan, app.v_plan_cost, app.v_cost_code,
  app.v_plan_option, app.v_takeoff_change, app.v_cis,
  app.v_budget_status, app.v_budget_check, app.v_community_xwalk
to authenticated;

notify pgrst, 'reload schema';



-- ============================================================================
--  run_select — the console's ad-hoc SELECT, read-only by construction
-- ============================================================================
-- ============================================================================
-- claude-run-select-v2.sql
--
-- Replaces app.run_select(). No verification statements in this file --
-- everything that can raise runs separately, for the reasons in v1's header.
--
-- ----------------------------------------------------------------------------
-- WHAT ADVERSARIAL TESTING OF v1 FOUND
--
-- v1 wrapped the caller's SQL as a subquery:
--     select ... from (select * from (%s) sub limit %s) t
-- and I claimed that stopped statement chaining. It does not. Balancing the
-- parentheses escapes it:
--     select 1) sub limit 1) t; select 2 as pwned; --
-- returned 2. plpgsql EXECUTE ran both commands and handed back the last
-- result. So the wrapper was never a boundary.
--
-- What DID hold, tested directly through that same escape:
--     ...; delete from flow_rows where false; ...
--         -> ERROR: DELETE is not allowed in a non-volatile function
--     ...; create table zzz_probe(x int); ...
--         -> ERROR: CREATE TABLE is not allowed in a non-volatile function
--     and information_schema confirmed no table was created.
-- STABLE is the real guarantee, exactly as designed. The wrapper was not.
--
-- THE REMAINING HARM, which is why this file exists:
--   * Chaining bypasses p_limit. A second unbounded SELECT returns everything,
--     which is a payload/DoS problem even with writes refused.
--   * It leaves a trap: if anyone ever changes STABLE to VOLATILE, chaining
--     escalates from "ignores the row cap" to "arbitrary writes".
--
-- THE FIX -- structural, not a filter.
--   Rejecting ';' would be another denylist, and would break legitimate
--   queries with semicolons inside string literals.
--   Instead the query now runs through a CURSOR. OPEN ... FOR EXECUTE plans
--   the string as a single prepared statement, and Postgres refuses
--   multi-command strings there:
--       ERROR: cannot insert multiple commands into a prepared statement
--   The row cap also moves into the fetch loop, so it is enforced by counting
--   rows rather than by SQL the caller can rewrite.
-- ============================================================================

create or replace function app.run_select(q text, p_limit int default 500)
returns jsonb
language plpgsql
stable                                    -- LOAD-BEARING. Verified above.
security invoker                          -- runs as caller; RLS applies
set search_path to 'app', 'public', 'pg_temp'
set statement_timeout to '15s'
as $$
declare
  curs   refcursor;
  rec    record;
  arr    jsonb := '[]'::jsonb;
  i      int   := 0;
  n      int   := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  if not public.hub_is_any_admin() then
    raise exception 'app.run_select is restricted to hub admins'
      using hint = 'No admin row for your account in app_roles, tf_app_roles '
                || 'or cdb_app_roles. This also fails in the Supabase SQL '
                || 'editor, which carries no JWT -- call it from the console.';
  end if;

  if q is null or btrim(q) = '' then
    raise exception 'Empty query.';
  end if;

  -- Single prepared statement: multi-command strings are rejected here by
  -- Postgres, which is what closes the chaining hole. No wrapping SQL is
  -- built around the caller's text at all now, so there are no parentheses
  -- to balance out of.
  open curs for execute q;

  loop
    fetch curs into rec;
    exit when not found;
    arr := arr || to_jsonb(rec);
    i := i + 1;
    exit when i >= n;          -- cap enforced by counting, not by SQL
  end loop;

  close curs;
  return arr;
end
$$;

revoke execute on function app.run_select(text, int) from public;
grant  execute on function app.run_select(text, int) to authenticated;

notify pgrst, 'reload schema';



-- ============================================================================
--  f_coverage_risk — trade coverage risk by community
-- ============================================================================
-- ============================================================================
-- claude-coverage-risk-v3.sql
--
-- Replaces app.f_coverage_risk(). No verification statements in this file --
-- anything that can raise goes in a separate run. I will verify from the
-- console, where a JWT exists.
--
-- ----------------------------------------------------------------------------
-- WHY v2 TIMED OUT -- measured, not guessed
--
-- I proposed two causes before and both were wrong. v2 blamed CTE inlining
-- and added AS MATERIALIZED; it made no difference (still timed out, at 25s).
-- Timing the pieces individually through run_select found the real cause in
-- one pass:
--
--     raw expansion of v_vendor_assignment (orlando)        274 ms
--     ... group by community with count(DISTINCT category)  7560 ms
--     ... group by community with count(*)                   186 ms
--     starts CTE                                             342 ms
--
-- count(DISTINCT category) was 40x the cost of count(*) over identical input.
-- Nothing to do with inlining, materialisation, or the JSONB payload. A
-- DISTINCT aggregate forces per-group sorting and blocks hash aggregation,
-- and the input is a function scan with no statistics or indexes for the
-- planner to work with.
--
-- THE FIX: de-duplicate first in a subquery, then plain count(*).
-- DISTINCT can hash-aggregate; count(DISTINCT) cannot.
--
--     full rewritten query, BOTH divisions:  391 ms   (was: 25s timeout)
--
-- The DISTINCT is still required, not incidental: 734 of 56,501
-- (community, category) pairs carry 2-3 vendors, so a bare count(*) over the
-- raw view would double-count those trades.
--
-- AS MATERIALIZED is dropped -- it was never the problem and it blocks the
-- planner from pushing the division filter down.
-- ============================================================================

create or replace function app.f_coverage_risk(
  p_division  text    default null,
  p_from      date    default current_date,
  p_to        date    default (current_date + interval '6 months')::date,
  p_threshold numeric default 0.5      -- flag below this share of the median
)
returns table (
  division_key     text,
  community_name   text,
  first_start      date,
  weeks_out        integer,
  starts_in_window bigint,
  trades_assigned  bigint,
  division_median  numeric,
  pct_of_median    numeric
)
language sql
stable
security invoker
set statement_timeout to '30s'
as $$
  with starts as (
    select s.division_key,
           s.community_name,
           count(*)::bigint  as n,
           min(s.start_date) as first_start
    from app.v_start s
    where s.start_date between p_from and p_to
      and (p_division is null or s.division_key = p_division)
    group by 1, 2
  ),
  trades as (
    -- de-duplicate, then count. See header: count(distinct) here cost 7.5s.
    select d.division_key, d.community_name, count(*)::bigint as k
    from (
      select distinct va.division_key, va.community_name, va.category
      from app.v_vendor_assignment va
      where (p_division is null or va.division_key = p_division)
    ) d
    group by 1, 2
  ),
  joined as (
    select st.division_key, st.community_name, st.first_start, st.n,
           coalesce(tr.k, 0) as k
    from starts st
    left join trades tr
      on  tr.division_key   = st.division_key
      and tr.community_name = st.community_name
  ),
  med as (
    -- percentile_cont returns double precision and round(double, int) does
    -- not exist; cast once so everything downstream is numeric.
    select division_key,
           (percentile_cont(0.5) within group (order by k))::numeric as m
    from joined
    group by 1
  )
  select j.division_key,
         j.community_name,
         j.first_start,
         ((j.first_start - current_date) / 7)::int,
         j.n,
         j.k,
         round(m.m, 0),
         case when m.m > 0 then round(100.0 * j.k / m.m, 1) end
  from joined j
  join med m on m.division_key = j.division_key
  where m.m > 0
    and j.k < m.m * p_threshold
  order by j.first_start, j.n desc;
$$;

revoke execute on function app.f_coverage_risk(text, date, date, numeric) from public;
grant  execute on function app.f_coverage_risk(text, date, date, numeric) to authenticated;

notify pgrst, 'reload schema';


-- ============================================================================
-- THE JOIN IS SOUND -- checked before trusting the output.
--
-- Tampa community names look like codes (Acacia 18 SER, NPC AA 60 CLA) while
-- Orlando's are full names, which raised the possibility that Tampa's zeros
-- were a name-matching failure rather than real missing coverage. They are
-- not:
--
--                      start names   all in catalog   matched in assigned
--     orlando               97             97                  93
--     tampa                143            143                 104
--
-- Every start-record community name resolves against the community catalog in
-- both divisions, so absence from vendors[].assigned is genuine absence.
-- Orlando's 4 unmatched are the same four found independently offline
-- (Riverwalk Towns, Tarpon Bay, Harvest Grove 20, Harvest Grove 25), which
-- cross-validates the whole path. Tampa has 39.
-- ============================================================================



-- ============================================================================
--  Grants — last, so every object above already exists
-- ============================================================================
-- ============================================================================
-- claude-console-grants.sql
--
-- Makes the app.* read surface reachable over PostgREST, for `authenticated`
-- only. Run after claude-domain-views.sql. Safe to re-run.
--
-- WHY THIS IS NEEDED
--   claude-domain-views.sql created the views but granted nothing on them.
--   Views are owned by postgres and default to no grant, so `authenticated`
--   currently cannot select from them -- the console page would get an empty
--   result or a 401 for every query. That was a gap in that file.
--
-- WHY THIS IS SAFE
--   * Every app.v_* view is SECURITY INVOKER. Granting SELECT does NOT grant
--     access to underlying rows -- RLS on public.division_data still decides
--     what each caller sees. A viewer who cannot read division_data today
--     still cannot read it through these views.
--   * `anon` is explicitly revoked at both the schema and object level, so the
--     published anon key gains nothing. Two independent barriers.
--   * SELECT and EXECUTE only. No INSERT/UPDATE/DELETE is granted anywhere,
--     so the console is structurally read-only -- not read-only by convention.
--   * No arbitrary-SQL endpoint. f_vendor_share takes typed scalar parameters
--     and builds no dynamic SQL, so there is nothing to inject into. (This is
--     deliberate: the earlier app.claude_query() idea was removed because
--     keyword denylists are defeatable by comment injection.)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Lock anon out first, so no window exists where it has access.
-- ----------------------------------------------------------------------------
revoke all on schema app from anon;
revoke all on all tables    in schema app from anon;
revoke all on all functions in schema app from anon;
revoke all on all routines  in schema app from anon;


-- ----------------------------------------------------------------------------
-- 2. Read access for signed-in users.
-- ----------------------------------------------------------------------------
grant usage on schema app to authenticated;

grant select on
  app.v_division,
  app.v_community,
  app.v_trade_category,
  app.v_vendor_assignment,
  app.v_start,
  app.vendor_alias,
  app.meta_table,
  app.meta_column,
  app.meta_metric
to authenticated;

-- Functions default to EXECUTE for PUBLIC, which is wider than intended.
-- Close that, then reopen for authenticated only.
revoke execute on function app.f_vendor_share(date, date, text, text, text) from public;
grant  execute on function app.f_vendor_share(date, date, text, text, text) to authenticated;

revoke execute on function app.describe_schema() from public;
grant  execute on function app.describe_schema() to authenticated;


-- ----------------------------------------------------------------------------
-- 3. Future objects in `app` should follow the same rule automatically.
--    Scoped to the `app` schema ONLY -- this does not touch public, so no
--    future table of yours is swept in. (That was the flaw in the very first
--    draft of the data layer; it is not repeated here.)
-- ----------------------------------------------------------------------------
alter default privileges in schema app grant select  on tables    to authenticated;
alter default privileges in schema app grant execute on functions to authenticated;
alter default privileges in schema app revoke all    on tables    from anon;
alter default privileges in schema app revoke all    on functions from anon;


-- ----------------------------------------------------------------------------
-- 4. MANUAL STEP -- required, cannot be done in SQL.
--
--    Supabase Dashboard -> Settings -> API -> "Exposed schemas"
--    Add:  app        (keep public; do not remove it)
--    Save.
--
--    Until you do this, PostgREST does not know the schema exists and the
--    console returns "schema must be one of the following: public".
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 5. VERIFY -- who can actually reach what.
--    Expect: rows for `authenticated` with SELECT, and NO rows for `anon`.
-- ----------------------------------------------------------------------------
select
  c.relname                                   as object_name,
  case c.relkind when 'v' then 'view'
                 when 'r' then 'table'
                 when 'm' then 'matview' end  as kind,
  r.rolname                                   as grantee,
  string_agg(distinct a.privilege_type, ', ' order by a.privilege_type) as privileges
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
join pg_roles r on r.oid = a.grantee
where n.nspname = 'app'
  and r.rolname in ('anon', 'authenticated', 'service_role')
group by 1, 2, 3
order by 3, 1;


-- ----------------------------------------------------------------------------
-- 6. The security audit that is still outstanding from the earlier file.
-- ----------------------------------------------------------------------------
select * from app.v_security_audit
order by case severity
           when 'CRITICAL' then 1
           when 'HIGH'     then 2
           when 'REVIEW'   then 3
           else 4
         end,
         check_name, object_name;
