-- ============================================================================
--  Admin account lifecycle hardening (cross-app). Idempotent; safe to re-run.
--  Applied live 2026-09-17; trigger bodies re-verified against live 2026-09-29.
--
--  Closes three residual paths by which a single-app admin could still take over
--  another admin over the SHARED auth.users:
--   1. REDEEM-TIME CHECK — a reset link can never set an admin's password, even
--      if the token was minted while the target was a non-admin (issue-time check
--      alone left a promote-after-issue window). Admin passwords are reset at the
--      DB level, never via a self-service link.
--   2. DEMOTE PROTECTION — a client (JWT) admin cannot change or remove ANOTHER
--      admin's role row, so the "demote peer, then reset them" bypass is closed.
--      service_role / SQL-editor (no JWT) still can, so admins are managed at the
--      DB level.
--   3. STALE-LINK INVALIDATION — promoting an email to admin burns any of its
--      outstanding reset links in both token pools.
-- ============================================================================

-- 1. Redeem-time admin check (both pools). The redeemers are defined ONLY in
--    their source-of-truth files, both of which carry this check:
--      Pool A  public.redeem_reset_token()      takeoff-flow/harden_reset_tokens_poolA.sql
--      Pool B  public.cdb_redeem_reset_token()  community-db/supabase_setup.sql
--    They used to be duplicated here; a re-run of an older copy elsewhere broke
--    every Pool A reset on 2026-09-29, so they are no longer copied.

-- 2 & 3. Role-table triggers (app_roles / tf_app_roles / cdb_app_roles / pdb_app_roles).
create or replace function public.protect_admin_role_change() returns trigger
 language plpgsql security definer set search_path to '' as $function$
declare caller text := lower(coalesce(auth.jwt()->>'email','')); begin
  -- service_role / SQL editor (no JWT) bypass, so admins can still be managed at the DB level
  if caller <> '' and old.role = 'admin' and lower(old.email) <> caller then
    raise exception 'You cannot change or remove another admin''s role. Do it at the database level.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $function$;

create or replace function public.invalidate_reset_tokens_on_admin() returns trigger
 language plpgsql security definer set search_path to '' as $function$
begin
  if new.role = 'admin' then
    if to_regclass('public.password_reset_tokens') is not null then
      update public.password_reset_tokens set used_at = now() where lower(email) = lower(new.email) and used_at is null; end if;
    if to_regclass('public.cdb_reset_tokens') is not null then
      update public.cdb_reset_tokens set used_at = now() where lower(email) = lower(new.email) and used_at is null; end if;
  end if;
  return new;
end $function$;

do $$ declare t text; begin
  foreach t in array array['app_roles','tf_app_roles','cdb_app_roles','pdb_app_roles'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists trg_protect_admin on public.%I', t);
      execute format('create trigger trg_protect_admin before update or delete on public.%I for each row execute function public.protect_admin_role_change()', t);
      execute format('drop trigger if exists trg_invalidate_tokens on public.%I', t);
      execute format('create trigger trg_invalidate_tokens after insert or update on public.%I for each row execute function public.invalidate_reset_tokens_on_admin()', t);
    end if;
  end loop;
end $$;
