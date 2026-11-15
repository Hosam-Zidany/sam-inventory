-- =====================================================================
-- SAM Inventory — migration 0003: privileges and row-level security
--
-- Two layers, both enforced by Postgres (not by hiding buttons):
--   1. GRANTs: authenticated users get only the table operations they could
--      ever need; anon gets nothing.
--   2. RLS policies: which ROWS each role may touch.
-- Writes to stock/sales go exclusively through the RPCs in 0002.
--
--   admin      everything
--   sales      products (read), customers, stock (read), own sales
--   warehouse  products (read), stock + movements
-- =====================================================================

-- Start from zero: Supabase grants new public tables to anon/authenticated.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Table privileges ----------------------------------------------------
grant select                          on public.locations      to authenticated;
grant select, insert, update, delete  on public.staff_roles    to authenticated;  -- rows limited to admin by RLS
grant select, insert, update          on public.products       to authenticated;  -- no DELETE: soft delete = active=false
grant select, insert, update, delete  on public.kit_components to authenticated;
grant select, insert, update          on public.customers      to authenticated;
grant select                          on public.sales          to authenticated;
grant select                          on public.sale_items     to authenticated;
grant select                          on public.stock_movements to authenticated;
grant select                          on public.stock_view     to authenticated;
grant select                          on public.stock_totals   to authenticated;
-- receipt_counter: no grants at all (only complete_sale touches it)

-- Function privileges -------------------------------------------------
grant execute on function public.app_role()                                        to authenticated;
grant execute on function public.receive_stock(uuid, text, integer, text)          to authenticated;
grant execute on function public.transfer_stock(uuid, text, text, integer, text)   to authenticated;
grant execute on function public.stock_take(uuid, text, integer, text)             to authenticated;
grant execute on function public.complete_sale(text, text, text, jsonb, uuid, text, uuid) to authenticated;
grant execute on function public.cancel_sale(uuid, text)                           to authenticated;

-- Enable RLS ----------------------------------------------------------
alter table public.locations       enable row level security;
alter table public.staff_roles     enable row level security;
alter table public.products        enable row level security;
alter table public.kit_components  enable row level security;
alter table public.customers       enable row level security;
alter table public.receipt_counter enable row level security;   -- no policies = closed
alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.stock_movements enable row level security;

-- locations -----------------------------------------------------------
create policy locations_read on public.locations
  for select to authenticated
  using ((select public.app_role()) is not null);

-- staff_roles: everyone sees their own row (the app needs it to pick the
-- menu); admins see and manage all.
create policy staff_roles_read on public.staff_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.app_role()) = 'admin');
create policy staff_roles_admin_write on public.staff_roles
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- products ------------------------------------------------------------
create policy products_read on public.products
  for select to authenticated
  using ((select public.app_role()) is not null);
create policy products_admin_insert on public.products
  for insert to authenticated
  with check ((select public.app_role()) = 'admin');
create policy products_admin_update on public.products
  for update to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- kit_components ------------------------------------------------------
create policy kit_components_read on public.kit_components
  for select to authenticated
  using ((select public.app_role()) is not null);
create policy kit_components_admin_write on public.kit_components
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- customers -----------------------------------------------------------
create policy customers_read on public.customers
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'sales'));
create policy customers_insert on public.customers
  for insert to authenticated
  with check ((select public.app_role()) in ('admin', 'sales'));
create policy customers_update on public.customers
  for update to authenticated
  using ((select public.app_role()) in ('admin', 'sales'))
  with check ((select public.app_role()) in ('admin', 'sales'));

-- sales / sale_items: admin sees all, sales sees only their own ------
create policy sales_read on public.sales
  for select to authenticated
  using (
    (select public.app_role()) = 'admin'
    or ((select public.app_role()) = 'sales' and user_id = (select auth.uid()))
  );

create policy sale_items_read on public.sale_items
  for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_items.sale_id));  -- inherits sales RLS

-- stock_movements: the full log is for admin + warehouse -------------
create policy stock_movements_read on public.stock_movements
  for select to authenticated
  using ((select public.app_role()) in ('admin', 'warehouse'));

-- No INSERT/UPDATE/DELETE policies or grants on sales, sale_items or
-- stock_movements: only the SECURITY DEFINER functions can write them.
