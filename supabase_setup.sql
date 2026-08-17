/* ==========================================================================
   Blueprint — Supabase setup
   Hub + admin console for the preconstruction tool suite. Shares the existing
   Supabase project with Vendor Assignments, Takeoff Flow and Community-DB.

   Run this whole file once in Supabase > SQL Editor. It is idempotent — safe to
   re-run after edits.

   SCOPE — deliberately small. This file creates:
     1. public.hub_apps            the runtime app registry (Blueprint's only table)
     2. public.hub_is_any_admin()  true if the caller is an admin in ANY app
     3. public.hub_pending_invites() unredeemed invite links, WITHOUT tokens

   It does NOT touch, alter or drop anything belonging to the three existing
   apps. Their role tables, token pools and RPCs are used exactly as-is:
     app_roles     / admin_add_or_reset()     / redeem_reset_token()      pool A
     tf_app_roles  / tf_admin_add_or_reset()  / redeem_reset_token()      pool A
     cdb_app_roles / cdb_admin_add_or_reset() / cdb_redeem_reset_token()  pool B
   ========================================================================== */

create extension if not exists pgcrypto;

/* -------------------------------------------------------------- helpers --- */

create or replace function public.hub_email() returns text
  language sql stable as $$ select lower(coalesce(auth.jwt()->>'email','')) $$;

-- Renamed from a legacy name (see the drop at the end of this file). The old
-- function cannot be dropped here — if a
-- previous version of this file has been run, hub_apps_read still depends on it,
-- and Postgres refuses (2BP01). The drop happens at the very end of this file,
-- after the policies have been rebuilt to use the new name and nothing points at
-- the old one. CASCADE would also "work", but it would silently take the policy
-- with it and leave the table briefly readable to anyone.
create or replace function public.hub_is_allowed_domain() returns boolean
  language sql stable as $$ select public.hub_email() like '%@lennar.com' $$;

-- True when the caller is an admin in ANY of the three apps.
--
-- SECURITY DEFINER because it reads three role tables the caller may not have
-- select rights on (and to avoid recursion against hub_apps' own policies).
-- Note this grants no new authority: it is only ever used to decide whether to
-- SHOW admin UI and to gate hub_apps writes. Every operation that actually
-- matters — minting a credential, changing a role — is still authorized by the
-- app's own RPC or RLS policy against its own role table. So an admin of only
-- Community-DB can open the console but still cannot mint a pool A token.
create or replace function public.hub_is_any_admin() returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare v_email text := public.hub_email(); v_found boolean := false;
begin
  if v_email = '' then return false; end if;

  begin
    select exists(select 1 from public.app_roles
                   where lower(email) = v_email and role = 'admin') into v_found;
    if v_found then return true; end if;
  exception when undefined_table then null;   -- app not installed; keep going
  end;

  begin
    select exists(select 1 from public.tf_app_roles
                   where lower(email) = v_email and role = 'admin') into v_found;
    if v_found then return true; end if;
  exception when undefined_table then null;
  end;

  begin
    select exists(select 1 from public.cdb_app_roles
                   where lower(email) = v_email and role = 'admin') into v_found;
    if v_found then return true; end if;
  exception when undefined_table then null;
  end;

  return false;
end $$;

revoke all on function public.hub_is_any_admin() from public;
grant execute on function public.hub_is_any_admin() to authenticated;

/* ------------------------------------------------------------ hub_apps ----- */
/* The app registry. Presentational columns are admin-editable from the UI;
   the wiring columns (role_table, *_rpc, token_pool, roles, division_source)
   are NOT — they are identifiers Blueprint interpolates into queries, so they
   are set here in SQL by whoever builds the backend. A trigger enforces this
   rather than relying on the client to behave.                              */

create table if not exists public.hub_apps (
  slug         text primary key,
  name         text not null,
  url          text not null,
  description  text,
  icon_url     text,                        -- null → UI shows a flagged placeholder
  authors      text[] not null default '{}',
  active       boolean not null default true,

  -- How the app authenticates. Not the same question as whether Blueprint can
  -- manage its roles: an Entra app is fully authenticated but its access lives in
  -- Entra, so it stays out of the Users tab. Defaults to 'entra' because an
  -- internal tool is far more likely behind the corporate sign-in than
  -- genuinely public — and defaulting to 'none' would label it "Public".
  auth_kind    text not null default 'entra'
                 check (auth_kind in ('shared','entra','other','none')),

  -- wiring. null role_table = launcher-only (a tile and nothing more).
  role_table   text,
  list_rpc     text,
  token_rpc    text,
  token_pool   text check (token_pool in ('A','B')),
  roles        text[] not null default '{}',
  division_scoped_roles text[] not null default '{}',
  division_source jsonb not null default '{"kind":"none"}'::jsonb,

  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,

  -- Only an app with a role table may claim the shared sign-in; otherwise it
  -- would appear in Users with nothing to read.
  constraint hub_apps_shared_needs_roles check (
    auth_kind <> 'shared' or role_table is not null
  ),

  -- A managed app needs all of its wiring, or none of it. Half-wired is the
  -- state that would produce confusing runtime failures.
  constraint hub_apps_wiring_complete check (
    (role_table is null and list_rpc is null and token_rpc is null and token_pool is null)
    or
    (role_table is not null and list_rpc is not null and token_rpc is not null and token_pool is not null)
  )
);

-- Backfill for a table created before auth_kind existed.
alter table public.hub_apps
  add column if not exists auth_kind text not null default 'entra';
do $$ begin
  alter table public.hub_apps add constraint hub_apps_auth_kind_valid
    check (auth_kind in ('shared','entra','other','none'));
exception when duplicate_object then null; end $$;
update public.hub_apps set auth_kind = 'shared'
  where role_table is not null and auth_kind <> 'shared';

comment on table public.hub_apps is
  'Blueprint app registry. Deleting a row removes only the launcher tile; it never touches an app''s role table, so removal cannot revoke anyone''s access.';

-- No sort_order column on purpose: the UI orders alphabetically by name with a
-- punctuation-insensitive collator, so there is no ordering to keep in sync.
create unique index if not exists hub_apps_name_key on public.hub_apps (lower(name));

/* stamp + protect wiring ---------------------------------------------------- */

-- Distinguishes a SQL-editor / service-role call (which may set wiring) from a
-- browser call (which may not). In the SQL editor request.jwt.claims is unset,
-- so this returns true; via PostgREST it reflects the real JWT role.
-- nullif guards the case where the setting exists but is empty, which would
-- otherwise fail on ''::jsonb.
create or replace function public.hub_is_service() returns boolean
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
      'service_role'
    ) in ('service_role','postgres')
  $$;

create or replace function public.hub_apps_touch() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    new.created_by := coalesce(new.created_by, public.hub_email());
    new.created_at := coalesce(new.created_at, now());
  end if;
  new.updated_by := public.hub_email();
  new.updated_at := now();

  -- On UPDATE, silently preserve the wiring columns. The client is not trusted
  -- to omit them; if it sends them, they are ignored.
  if (tg_op = 'UPDATE') then
    new.role_table            := old.role_table;
    new.list_rpc              := old.list_rpc;
    new.token_rpc             := old.token_rpc;
    new.token_pool            := old.token_pool;
    new.roles                 := old.roles;
    new.division_scoped_roles := old.division_scoped_roles;
    new.division_source       := old.division_source;
    new.slug                  := old.slug;
  end if;

  -- On INSERT from a client, refuse to accept wiring at all. Apps added
  -- through the UI are launcher-only until someone edits them here in SQL.
  if (tg_op = 'INSERT') then
    if new.role_table is not null and not public.hub_is_service() then
      new.role_table := null; new.list_rpc := null;
      new.token_rpc := null;  new.token_pool := null;
      new.roles := '{}';      new.division_scoped_roles := '{}';
      new.division_source := '{"kind":"none"}'::jsonb;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists hub_apps_touch_trg on public.hub_apps;
create trigger hub_apps_touch_trg before insert or update on public.hub_apps
  for each row execute function public.hub_apps_touch();

/* RLS ---------------------------------------------------------------------- */

/* RLS is the security boundary for this table. The anon key is public by design,
   so without a policy the table would be world-readable. Belt and braces:
     · RLS enabled, with every policy scoped `to authenticated`
     · table privileges revoked from anon entirely, so an unauthenticated request
       is refused before policy evaluation even happens
   A verification block at the end of this file fails loudly if either is missing,
   because an accidentally-unprotected table is not something to discover later. */
alter table public.hub_apps enable row level security;

revoke all on public.hub_apps from anon;
grant select, insert, update, delete on public.hub_apps to authenticated;

-- Everyone signed in on the approved domain sees the active tiles; admins see
-- everything including deactivated apps.
drop policy if exists hub_apps_read on public.hub_apps;
create policy hub_apps_read on public.hub_apps for select to authenticated
  using (public.hub_is_allowed_domain() and (active or public.hub_is_any_admin()));

drop policy if exists hub_apps_insert on public.hub_apps;
create policy hub_apps_insert on public.hub_apps for insert to authenticated
  with check (public.hub_is_any_admin());

drop policy if exists hub_apps_update on public.hub_apps;
create policy hub_apps_update on public.hub_apps for update to authenticated
  using (public.hub_is_any_admin()) with check (public.hub_is_any_admin());

-- Any app may be removed, managed or not. This deletes the registry row only;
-- app_roles / tf_app_roles / cdb_app_roles are never referenced here, so no
-- user can lose access as a result.
drop policy if exists hub_apps_delete on public.hub_apps;
create policy hub_apps_delete on public.hub_apps for delete to authenticated
  using (public.hub_is_any_admin());

/* ------------------------------------------------- pending invite links --- */
/* The token tables hold bearer credentials: whoever has an unredeemed token can
   set that user's password. So they are NOT exposed to the client. This function
   is the only read path, and the token column is absent from its return type —
   which means it cannot leak regardless of what the client asks for.

   Pool A stores expires_at. Pool B stores only created_at and hardcodes 14 days
   inside cdb_redeem_reset_token(), so the expiry is computed here to match.   */

create or replace function public.hub_pending_invites()
returns table (
  email      text,
  pool       text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.hub_is_any_admin() then
    raise exception 'not authorized';
  end if;

  begin
    return query
      select t.email, 'A'::text, t.created_at, t.expires_at
        from public.password_reset_tokens t
       where t.used_at is null and t.expires_at > now();
  exception when undefined_table then null;
  end;

  begin
    return query
      select t.email, 'B'::text, t.created_at,
             (t.created_at + interval '14 days')
        from public.cdb_reset_tokens t
       where t.used_at is null
         and t.created_at > now() - interval '14 days';
  exception when undefined_table then null;
  end;

  return;
end $$;

revoke all on function public.hub_pending_invites() from public;
grant execute on function public.hub_pending_invites() to authenticated;

/* ---------------------------------------------------------------- seed ---- */
/* Seeds the four current apps. Wiring is set here because this runs as the SQL
   editor (service role), which the trigger permits. Re-running updates the
   presentational fields and leaves wiring intact.                            */

insert into public.hub_apps
  (slug, name, url, description, icon_url, authors, active, auth_kind,
   role_table, list_rpc, token_rpc, token_pool, roles, division_scoped_roles, division_source)
values
  ('Vendor-Portal', 'Vendor Assignments',
   'https://ssvedman.github.io/Vendor-Portal/',
   'Division vendor assignments, coverage gaps and starts, imported from E1 exports.',
   'https://ssvedman.github.io/Vendor-Portal/logo.svg',
   array['Stephen Svedman'], true, 'shared',
   'app_roles', 'admin_list_users', 'admin_add_or_reset', 'A',
   array['admin','editor','viewer'], array['editor'],
   '{"kind":"table","table":"app_divisions"}'::jsonb),

  ('Takeoff-Flow', 'Takeoff Flow',
   'https://ssvedman.github.io/Takeoff-Flow/',
   'Editable takeoff schedule with WORKDAY date math, pending budgets and change log.',
   'https://ssvedman.github.io/Takeoff-Flow/logo.svg',
   array['Stephen Svedman'], true, 'shared',
   'tf_app_roles', 'tf_admin_list_users', 'tf_admin_add_or_reset', 'A',
   array['admin','editor','purchasing','viewer'], array['editor','purchasing'],
   '{"kind":"config"}'::jsonb),

  ('Community-DB', 'Community-DB',
   'https://ssvedman.github.io/Community-DB/',
   'Community information sheets with draft/publish workflow, images and meeting notes.',
   'https://ssvedman.github.io/Community-DB/logo.svg',
   array['Denis Crepes','Stephen Svedman'], true, 'shared',
   'cdb_app_roles', 'cdb_admin_list_users', 'cdb_admin_add_or_reset', 'B',
   array['admin','editor','viewer'], array[]::text[],
   '{"kind":"config"}'::jsonb),

  -- Launcher-only: no sign-in, its own separate database, another GitHub owner,
  -- and no logo.svg published (icon_url null → flagged placeholder in the UI).
  ('lennar-map', 'Community Map',
   'https://grant-slater.github.io/lennar-map/',
   'Orlando division community map — starts by month, trade-partner and vendor filters, utilities and municipality.',
   null,
   array['Grant Slater'], true, 'none',
   null, null, null, null, array[]::text[], array[]::text[],
   '{"kind":"none"}'::jsonb)

on conflict (slug) do update set
  name        = excluded.name,
  url         = excluded.url,
  description = excluded.description,
  icon_url    = excluded.icon_url,
  authors     = excluded.authors,
  auth_kind   = excluded.auth_kind;

/* ------------------------------------------------- rename cleanup --------- */
/* Safe now: the policies above were rebuilt to call hub_is_allowed_domain(), so
   nothing depends on the old name. No-op on a first install.                  */
drop function if exists public.hub_is_lennar();

/* ------------------------------------------------------------- verify ----- */
/* Assert rather than trust. If this file is edited later and RLS or a policy is
   dropped, the next run fails here instead of quietly leaving the registry open
   to anyone holding the (public) anon key. */
do $$
declare
  v_rls      boolean;
  v_policies int;
  v_anon     int;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.hub_apps'::regclass;
  if not coalesce(v_rls, false) then
    raise exception 'SECURITY: row level security is NOT enabled on public.hub_apps';
  end if;

  select count(*) into v_policies from pg_policies
   where schemaname = 'public' and tablename = 'hub_apps';
  if v_policies < 4 then
    raise exception 'SECURITY: hub_apps has only % policies; expected read/insert/update/delete', v_policies;
  end if;

  -- Any table privilege still held by anon would bypass the intent above.
  select count(*) into v_anon
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'hub_apps' and grantee = 'anon';
  if v_anon > 0 then
    raise exception 'SECURITY: anon still holds % privileges on public.hub_apps', v_anon;
  end if;

  raise notice 'Blueprint: RLS enabled, % policies, anon has no table privileges.', v_policies;
end $$;

-- Expected: 4 rows, ordered Community-DB, Community Map, Takeoff Flow,
-- Vendor Assignments once the client's collator is applied.
--
--   select slug, name, role_table is not null as managed, auth_kind, token_pool
--     from public.hub_apps order by name;
--   select * from public.hub_pending_invites();
--   select public.hub_is_any_admin();
--
-- And to confirm protection independently:
--   select relrowsecurity from pg_class where oid = 'public.hub_apps'::regclass;  -- t
--   select policyname, cmd, roles from pg_policies where tablename = 'hub_apps';
