-- First-admin bootstrap (migration 0005). Runs on a database with NO staff yet,
-- inside a transaction that rolls back.
\set ON_ERROR_STOP on
\o /dev/null
begin;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-00000000000a', 'owner@test'),
  ('d0000000-0000-0000-0000-00000000000b', 'intruder@test');

do $$
declare ok boolean;
begin
  -- anonymous visitors cannot call either function
  set local role anon;
  begin
    perform public.needs_first_admin();
    raise exception 'FAIL: anon could call needs_first_admin';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- a signed-in user with no role: the project needs its first admin
  perform set_config('request.jwt.claims', json_build_object('sub', 'd0000000-0000-0000-0000-00000000000a')::text, true);
  set local role authenticated;
  if public.needs_first_admin() is not true then raise exception 'FAIL: fresh project should need a first admin'; end if;

  -- claim succeeds exactly once
  if public.claim_first_admin('Owner') is not true then raise exception 'FAIL: first claim should succeed'; end if;
  if public.app_role() <> 'admin' then raise exception 'FAIL: claimer is not admin'; end if;
  if public.needs_first_admin() is not false then raise exception 'FAIL: needs_first_admin should now be false'; end if;

  -- a second user cannot take over
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', 'd0000000-0000-0000-0000-00000000000b')::text, true);
  set local role authenticated;
  if public.claim_first_admin('Intruder') is not false then raise exception 'FAIL: second claim must be refused'; end if;
  if public.app_role() is not null then raise exception 'FAIL: intruder got a role'; end if;

  -- no JWT at all
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role authenticated;
  begin
    perform public.claim_first_admin();
    raise exception 'FAIL: claim without a user should be forbidden';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS: first-admin bootstrap (claim once, no takeover, anon/no-user refused)';
end $$;

\o
rollback;
