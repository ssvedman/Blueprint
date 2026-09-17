-- ============================================================================
--  Admin account lifecycle hardening (cross-app). Idempotent; safe to re-run.
--  Applied live 2026-09-17. Complements harden_admin_no_peer_reset.sql.
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

-- 1. Redeem-time admin check (both pools). Requires public.is_admin_email(text).
create or replace function public.redeem_reset_token(p_token text, p_new_password text)
 returns json language plpgsql security definer set search_path to '' as $function$
declare r record;
begin
  if p_new_password is null or length(p_new_password) < 8 then
    return json_build_object('ok', false, 'error', 'Password must be at least 8 characters.'); end if;
  select * into r from public.password_reset_tokens
   where token = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return json_build_object('ok', false, 'error', 'Invalid or unknown link.'); end if;
  if r.used_at is not null then return json_build_object('ok', false, 'error', 'This link has already been used.'); end if;
  if r.expires_at < now() then return json_build_object('ok', false, 'error', 'This link has expired.'); end if;
  if public.is_admin_email(r.email) then
    return json_build_object('ok', false, 'error', 'Admin passwords must be reset by an administrator directly, not via a reset link.'); end if;
  update auth.users set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')), updated_at = now()
   where lower(email) = r.email;
  if not found then return json_build_object('ok', false, 'error', 'Account not found.'); end if;
  update public.password_reset_tokens set used_at = now() where token = r.token;
  return json_build_object('ok', true);
end; $function$;

create or replace function public.cdb_redeem_reset_token(p_token text, p_new_password text)
 returns jsonb language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare v_email text; v_created timestamptz; v_used timestamptz;
        v_hash text := encode(digest(coalesce(p_token,''), 'sha256'), 'hex'); begin
  if length(coalesce(p_new_password,'')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'Password must be at least 8 characters.'); end if;
  select email, created_at, used_at into v_email, v_created, v_used from public.cdb_reset_tokens where token = v_hash;
  if v_email is null then return jsonb_build_object('ok', false, 'error', 'Invalid link.'); end if;
  if v_used is not null then return jsonb_build_object('ok', false, 'error', 'This link was already used.'); end if;
  if now() - v_created > interval '14 days' then return jsonb_build_object('ok', false, 'error', 'This link has expired.'); end if;
  if public.is_admin_email(v_email) then
    return jsonb_build_object('ok', false, 'error', 'Admin passwords must be reset by an administrator directly, not via a reset link.'); end if;
  update public.cdb_reset_tokens set used_at = now() where token = v_hash and used_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'This link was already used.'); end if;
  update auth.users set encrypted_password = crypt(p_new_password, gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
   where lower(email) = v_email;
  if not found then return jsonb_build_object('ok', false, 'error', 'Account not found.'); end if;
  begin
    delete from auth.sessions where user_id::text = (select id::text from auth.users where lower(email) = v_email);
    delete from auth.refresh_tokens where user_id::text = (select id::text from auth.users where lower(email) = v_email);
  exception when undefined_table or undefined_column or undefined_function or insufficient_privilege then null; end;
  return jsonb_build_object('ok', true);
end $function$;

-- 2 & 3. Role-table triggers (app_roles / tf_app_roles / cdb_app_roles).
create or replace function public.protect_admin_role_change() returns trigger
 language plpgsql security definer set search_path to '' as $function$
declare caller text := lower(coalesce(auth.jwt()->>'email','')); begin
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
  foreach t in array array['app_roles','tf_app_roles','cdb_app_roles'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists trg_protect_admin on public.%I', t);
      execute format('create trigger trg_protect_admin before update or delete on public.%I for each row execute function public.protect_admin_role_change()', t);
      execute format('drop trigger if exists trg_invalidate_tokens on public.%I', t);
      execute format('create trigger trg_invalidate_tokens after insert or update on public.%I for each row execute function public.invalidate_reset_tokens_on_admin()', t);
    end if;
  end loop;
end $$;
