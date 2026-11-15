-- =====================================================================
-- SAM Inventory — migration 0001: schema, stock view, integrity triggers
--
-- Departures from the master prompt are tagged "SPEC FIX" with the reason.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- Reference data: the three stock locations
-- ---------------------------------------------------------------------
create table public.locations (
  id         text primary key check (id in ('display', 'storage', 'warehouse')),
  name_en    text not null,
  name_ar    text not null,
  sort_order integer not null
);

insert into public.locations (id, name_en, name_ar, sort_order) values
  ('display',   'Display',   'المعرض',   1),
  ('storage',   'Storage',   'المخزن',   2),
  ('warehouse', 'Warehouse', 'المستودع', 3);

-- ---------------------------------------------------------------------
-- Staff roles
-- ---------------------------------------------------------------------
create table public.staff_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('admin', 'sales', 'warehouse')),
  full_name  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Role of the calling user (NULL = not staff / deactivated). Used by RLS,
-- the stock views and every RPC.
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.staff_roles where user_id = auth.uid() and active
$$;

create or replace function public.require_role(variadic p_roles text[])
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_role text := public.app_role();
begin
  if v_role is null or not (v_role = any (p_roles)) then
    raise exception 'forbidden: requires role %', array_to_string(p_roles, ' or ')
      using errcode = '42501';
  end if;
  return v_role;
end;
$$;

-- Never leave the system without an admin.
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.role = 'admin' and old.active
     and (tg_op = 'DELETE' or not (new.role = 'admin' and new.active)) then
    if not exists (
      select 1 from public.staff_roles
      where role = 'admin' and active and user_id <> old.user_id
    ) then
      raise exception 'last_admin: cannot remove, demote or deactivate the last active admin';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger staff_roles_guard_last_admin
  before update or delete on public.staff_roles
  for each row execute function public.guard_last_admin();

-- ---------------------------------------------------------------------
-- Catalog
-- SPEC FIX: kit_parent_id removed. A single FK cannot express a BOM ratio
-- ("1 kit = 2 of component X"), so kits use the kit_components table below.
-- Added: specs (present in the PDF import), cost_usd (needed for the stock
-- valuation report), reorder_level (low-stock threshold, default 3).
-- ---------------------------------------------------------------------
create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  item_code          text not null,
  name               text not null,
  name_ar            text,
  category           text,
  unit               text not null default 'قطعة',
  specs              text,
  price_usd          numeric(12, 2) not null default 0 check (price_usd >= 0),
  price_syp          numeric(14, 0) not null default 0 check (price_syp >= 0),
  wireless_price_usd numeric(12, 2) check (wireless_price_usd >= 0),
  wireless_price_syp numeric(14, 0) check (wireless_price_syp >= 0),
  cost_usd           numeric(12, 2) check (cost_usd >= 0),
  for_sale           boolean not null default false,
  barcode            text,
  reorder_level      integer not null default 3 check (reorder_level >= 0),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  constraint products_item_code_key unique (item_code),
  constraint products_item_code_nonblank check (btrim(item_code) <> ''),
  constraint products_name_nonblank check (btrim(name) <> '')
);

create unique index products_barcode_key on public.products (barcode) where barcode is not null;
create index products_for_sale_idx on public.products (for_sale) where active;
create index products_category_idx on public.products (category);
create index products_name_trgm      on public.products using gin (name      extensions.gin_trgm_ops);
create index products_name_ar_trgm   on public.products using gin (name_ar   extensions.gin_trgm_ops);
create index products_item_code_trgm on public.products using gin (item_code extensions.gin_trgm_ops);

-- Kit bill of materials: selling 1 kit deducts `qty` of each component.
create table public.kit_components (
  kit_id       uuid not null references public.products (id),
  component_id uuid not null references public.products (id),
  qty          integer not null check (qty > 0),
  primary key (kit_id, component_id),
  check (kit_id <> component_id)
);

-- One level of nesting only (a component cannot itself be a kit).
create or replace function public.guard_kit_components()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.kit_components where kit_id = new.component_id) then
    raise exception 'nested_kit: component % is itself a kit', new.component_id;
  end if;
  if exists (select 1 from public.kit_components where component_id = new.kit_id) then
    raise exception 'nested_kit: kit % is already a component of another kit', new.kit_id;
  end if;
  return new;
end;
$$;

create trigger kit_components_guard
  before insert or update on public.kit_components
  for each row execute function public.guard_kit_components();

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  phone       text,
  is_wireless boolean not null default false,
  created_at  timestamptz not null default now()
);
create index customers_name_trgm on public.customers using gin (name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Sales
-- SPEC FIX: receipt numbers come from a counter row, not a SEQUENCE.
-- Sequences skip values when a transaction rolls back (e.g. a sale blocked
-- for low stock), which would leave gaps in a numbered receipt book. The
-- counter is updated inside the sale transaction, so a failed sale burns no
-- number. Cost: sales serialise on one row, which is fine for a few staff.
-- ---------------------------------------------------------------------
create table public.receipt_counter (
  singleton   boolean primary key default true check (singleton),
  last_number bigint not null
);
insert into public.receipt_counter (last_number) values (1000);   -- first receipt: R-1001

create table public.sales (
  id             uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  client_ref     uuid unique,                 -- idempotency key for the offline queue
  customer_id    uuid references public.customers (id),
  customer_name  text,
  currency       text not null check (currency in ('USD', 'SYP')),
  price_tier     text not null check (price_tier in ('general', 'wireless')),
  total          numeric(14, 2) not null check (total >= 0),
  sold_from      text not null references public.locations (id),
  status         text not null default 'completed' check (status in ('completed', 'cancelled')),
  cancelled_at   timestamptz,
  cancelled_by   uuid references auth.users (id),
  cancel_reason  text,
  user_id        uuid references auth.users (id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index sales_created_at_idx on public.sales (created_at desc);
create index sales_user_idx on public.sales (user_id, created_at desc);

-- SPEC FIX: no ON DELETE CASCADE — sales are never deleted (rule 5), they
-- are cancelled. Added line_total so reports do not recompute it.
create table public.sale_items (
  id             bigint generated always as identity primary key,
  sale_id        uuid not null references public.sales (id),
  product_id     uuid not null references public.products (id),
  qty            integer not null check (qty > 0),
  unit_price     numeric(14, 2) not null check (unit_price >= 0),
  price_currency text not null check (price_currency in ('USD', 'SYP')),
  line_total     numeric(14, 2) generated always as (qty * unit_price) stored
);
create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_product_idx on public.sale_items (product_id);

-- ---------------------------------------------------------------------
-- Stock movements — the only way stock changes.
-- SPEC FIX: the original schema could only ADD stock on an adjustment, so a
-- stock take that finds fewer units than expected was impossible. An
-- adjustment now has exactly one of to_location (increase) / from_location
-- (decrease). The CHECK below pins the shape of every movement type.
-- ---------------------------------------------------------------------
create table public.stock_movements (
  id            bigint generated always as identity primary key,
  product_id    uuid not null references public.products (id),
  type          text not null check (type in ('receiving', 'sale', 'transfer', 'adjustment', 'return')),
  qty           integer not null check (qty > 0),
  from_location text references public.locations (id),
  to_location   text references public.locations (id),
  sale_id       uuid references public.sales (id),
  user_id       uuid references auth.users (id) default auth.uid(),
  note          text,
  created_at    timestamptz not null default now(),
  constraint movement_shape check (
       (type = 'receiving'  and to_location is not null and from_location is null)
    or (type = 'sale'       and from_location is not null and to_location is null)
    or (type = 'transfer'   and from_location is not null and to_location is not null
                            and from_location <> to_location)
    or (type = 'adjustment' and (from_location is null) <> (to_location is null))
    or (type = 'return'     and to_location is not null and from_location is null)
  )
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_created_idx on public.stock_movements (created_at desc);
create index stock_movements_sale_idx    on public.stock_movements (sale_id) where sale_id is not null;

-- Append-only: history can never be edited or erased.
create or replace function public.block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;

create trigger stock_movements_append_only
  before update or delete on public.stock_movements
  for each row execute function public.block_mutation();
create trigger stock_movements_no_truncate
  before truncate on public.stock_movements
  for each statement execute function public.block_mutation();
create trigger sales_no_delete
  before delete on public.sales
  for each row execute function public.block_mutation();
create trigger sale_items_append_only
  before update or delete on public.sale_items
  for each row execute function public.block_mutation();

-- ---------------------------------------------------------------------
-- Derived stock (never stored)
-- Every movement adds to to_location and subtracts from from_location.
-- SPEC FIX: rewritten from the spec's cross join over stock_movements. This
-- lists every product × location (zeros included, which the stock matrix
-- needs) and uses the from/to rule above, which also makes decreasing
-- adjustments work.
-- The view runs with its owner's rights (so sales staff can read stock
-- without read access to the movements log) and gates itself by role.
-- ---------------------------------------------------------------------
create or replace function public.stock_of(p_product uuid, p_location text)
returns integer
language sql stable
set search_path = public
as $$
  select (
    coalesce(sum(qty) filter (where to_location = p_location), 0)
  - coalesce(sum(qty) filter (where from_location = p_location), 0)
  )::integer
  from public.stock_movements
  where product_id = p_product
    and (to_location = p_location or from_location = p_location)
$$;

create view public.stock_view as
with deltas as (
  select product_id, to_location as location, sum(qty) as qty
  from public.stock_movements where to_location is not null
  group by product_id, to_location
  union all
  select product_id, from_location, -sum(qty)
  from public.stock_movements where from_location is not null
  group by product_id, from_location
)
select p.id as product_id,
       l.id as location,
       coalesce(sum(d.qty), 0)::integer as qty
from public.products p
cross join public.locations l
left join deltas d on d.product_id = p.id and d.location = l.id
where (select public.app_role()) is not null
group by p.id, l.id;

create view public.stock_totals as
select product_id, sum(qty)::integer as total_qty
from public.stock_view
group by product_id;
