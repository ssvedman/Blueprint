-- ============================================================================
--  Shared database — remove anon's default table privileges
--
--  RUN THE AUDIT (section 1) FIRST AND READ IT. Section 2 is the change.
--  Safe to re-run. Nothing here drops data or alters a policy.
--
--  ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
--  A query of information_schema.role_table_grants showed `anon` holding SELECT,
--  INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on essentially every
--  table in this database — division_data, flow_rows, cdb_cis, app_roles, the
--  lot.
--
--  That is Supabase's default. A new project runs
--      grant all on all tables in schema public to anon, authenticated;
--  and relies entirely on row-level security to decide what those roles can
--  actually see. It is not a misconfiguration anyone made here.
--
--  It does mean the protection is single-layered. Every one of these five apps
--  publishes the same anon key in a public GitHub repo, so the key is not a
--  secret and never was. With these grants in place, the ONLY thing standing
--  between an anonymous request and a table is RLS. That works — but it means:
--
--    · A table created later without `enable row level security` is world
--      readable AND writable the moment it exists. No warning, no error.
--    · A policy written without a `to authenticated` clause applies to PUBLIC,
--      which includes anon. Community-DB has twelve of those today. They are
--      safe only because their USING clause calls cdb_is_lennar(), which is
--      false without a JWT — the expression is doing the work the role scoping
--      should be doing.
--    · TRUNCATE is not subject to RLS at all. It is not reachable through
--      PostgREST, which exposes no verb for it, so this is not an open door —
--      but it is a privilege granted for no reason.
--
--  Revoking these costs nothing. The apps authenticate before they read, so they
--  operate as `authenticated`, which keeps its grants. Nothing in Vendor
--  Assignments, Takeoff Flow, Community-DB or Blueprint reads anything while
--  signed out.
--
--  The one exception is the Community Map, which has no sign-in by design. It
--  reads exactly one object — the map_public view — and section 2 preserves that
--  grant explicitly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. AUDIT — run this on its own first
-- ---------------------------------------------------------------------------

-- 1a. The question that actually matters. Any table listed here with RLS
--     disabled is readable and writable by anyone holding the public anon key.
--     Expect zero rows.
select c.relname as table_without_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and not c.relrowsecurity
 order by 1;

-- 1b. Policies scoped to PUBLIC rather than to a role. These apply to anon.
--     Safe only if the USING expression rejects a request with no JWT.
select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and (roles is null or roles = '{public}')
 order by tablename, policyname;

-- 1c. Every table anon can currently touch, collapsed to one row per table.
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as anon_has
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
 group by table_name
 order by table_name;

-- ---------------------------------------------------------------------------
-- 2. THE CHANGE — revoke anon's table privileges, keep the map's view
--
--  Reversible in one line if anything unexpected breaks:
--      grant all on all tables in schema public to anon;
--  though if that turns out to be necessary, the right response is to find which
--  unauthenticated read needs it rather than to restore the lot.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  n int := 0;
begin
  -- Tables and views alike. The map_public view is re-granted immediately after.
  for r in
    select c.relname, c.relkind
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind in ('r', 'v', 'm', 'p')
     order by c.relname
  loop
    execute format('revoke all on public.%I from anon', r.relname);
    n := n + 1;
  end loop;
  raise notice 'Revoked anon privileges on % objects in public.', n;
end $$;

-- Stop anon inheriting privileges on anything created later. This is the line
-- that prevents the problem recurring the next time a table is added: without
-- it, Supabase's default privileges hand the new table straight back to anon.
alter default privileges in schema public revoke all on tables from anon;

-- The Community Map is unauthenticated by design and reads one view. If that
-- view does not exist yet, run map_supabase_setup.sql first — this is a no-op
-- until then rather than an error, so the order does not matter.
do $$
begin
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'map_public') then
    execute 'grant select on public.map_public to anon';
    raise notice 'Re-granted select on map_public to anon (the public Community Map).';
  else
    raise notice 'map_public does not exist yet — run map_supabase_setup.sql, then re-run this file.';
  end if;
end $$;

-- The signed-in role keeps everything it had; RLS still decides the rows.
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- 3. VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select distinct table_name
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' and table_name <> 'map_public'
     order by table_name
  loop
    v_bad := v_bad || '  · ' || r.table_name || E'\n';
  end loop;

  if v_bad <> '' then
    raise exception E'anon still holds privileges on:\n%', v_bad;
  end if;

  raise notice 'anon now reaches nothing in public except map_public.';
  raise notice 'RLS remains the row-level boundary; this added the missing outer one.';
end $$;

-- Confirm for yourself. Expect exactly one row: map_public, SELECT.
select table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
 order by table_name, privilege_type;
