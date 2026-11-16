-- =====================================================================
-- SAM Inventory — migration 0005: first-admin bootstrap
--
-- A brand-new project has no admin, and nobody can grant roles before one
-- exists. claim_first_admin() lets the first signed-in user become admin,
-- and ONLY while no active admin exists. After that it always refuses.
--
-- Safety note: this is first-come-first-served. Create your own account
-- first, claim immediately, and keep public sign-ups switched off in
-- Supabase (Authentication → Providers → Email → "Allow new users to sign up" off).
-- =====================================================================

create or replace function public.claim_first_admin(p_full_name text default null)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden: sign in first' using errcode = '42501';
  end if;

  -- One claim at a time, so two people cannot both win.
  perform pg_advisory_xact_lock(hashtextextended('claim_first_admin', 0));

  if exists (select 1 from public.staff_roles where role = 'admin' and active) then
    return false;
  end if;

  insert into public.staff_roles (user_id, role, full_name, active)
  values (auth.uid(), 'admin', nullif(btrim(p_full_name), ''), true)
  on conflict (user_id) do update
    set role = 'admin', active = true,
        full_name = coalesce(excluded.full_name, public.staff_roles.full_name);
  return true;
end;
$$;

-- True while the project still needs its first admin (used to decide whether
-- to show the "claim ownership" button). Reveals nothing else.
create or replace function public.needs_first_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select not exists (select 1 from public.staff_roles where role = 'admin' and active)
$$;

revoke all on function public.claim_first_admin(text) from public, anon, authenticated;
revoke all on function public.needs_first_admin()     from public, anon, authenticated;
grant execute on function public.claim_first_admin(text) to authenticated;
grant execute on function public.needs_first_admin()     to authenticated;
