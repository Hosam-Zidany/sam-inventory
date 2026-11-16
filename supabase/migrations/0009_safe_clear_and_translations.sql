-- =====================================================================
-- SAM Inventory — migration 0009: safe admin reset and top-level labels
-- =====================================================================

create or replace function public.clear_catalog_and_history()
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  perform public.require_role('admin');
  select count(*) into v_count from public.products;

  -- The reset is the one deliberate exception to append-only history.
  alter table public.stock_movements disable trigger stock_movements_append_only;
  alter table public.stock_movements disable trigger stock_movements_no_truncate;
  alter table public.sales disable trigger sales_no_delete;
  alter table public.sale_items disable trigger sale_items_append_only;

  truncate table
    public.stock_movements,
    public.sale_items,
    public.sales,
    public.customers,
    public.kit_components,
    public.products
    restart identity cascade;

  alter table public.stock_movements enable trigger stock_movements_append_only;
  alter table public.stock_movements enable trigger stock_movements_no_truncate;
  alter table public.sales enable trigger sales_no_delete;
  alter table public.sale_items enable trigger sale_items_append_only;

  update public.receipt_counter
  set last_number = 1000
  where singleton = true;
  return v_count;
exception
  when others then
    alter table public.stock_movements enable trigger stock_movements_append_only;
    alter table public.stock_movements enable trigger stock_movements_no_truncate;
    alter table public.sales enable trigger sales_no_delete;
    alter table public.sale_items enable trigger sale_items_append_only;
    raise;
end;
$$;

revoke all on function public.clear_catalog_and_history() from public, anon, authenticated;
grant execute on function public.clear_catalog_and_history() to authenticated;
