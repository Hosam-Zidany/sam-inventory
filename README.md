# SAM Inventory & Receipts

Bilingual (English / Arabic, RTL) inventory and digital-receipt app for SAM Company.
Stack: Next.js + Tailwind/shadcn · Supabase (Postgres, Auth, RLS) · Vercel.

**Status: build step 1 of 6 — database, roles, RLS.** The Next.js app starts in step 2;
the one-command local run arrives with it.

## What is in step 1

```
supabase/
  migrations/
    0001_schema.sql      tables, derived stock view, append-only triggers
    0002_functions.sql   receive_stock, transfer_stock, stock_take, complete_sale, cancel_sale
    0003_rls.sql         grants + row-level security per role
  seed.sql               local-dev placeholder products (never run on db push)
  tests/
    00_local_shim.sql    stand-in for Supabase's auth schema, for plain Postgres
    acceptance.sql       61 checks, runs in a transaction and rolls back
scripts/test-db.sh       builds a scratch DB, applies everything, runs the tests
```

## Setup

1. Create a Supabase project. Copy the project URL and anon key into `.env.local`
   (see `.env.example`; the app uses them from step 2).
2. Apply the migrations, either way:
   - Supabase CLI: `supabase link --project-ref <ref> && supabase db push`
   - or paste `0001`, `0002`, `0003` into the SQL editor, in order.
3. Create users under **Authentication → Users**, then give each a role. The first
   admin must be created by hand (nobody can grant roles before one exists):

   ```sql
   insert into public.staff_roles (user_id, role, full_name)
   select id, 'admin', 'Owner' from auth.users where email = 'owner@example.com';
   ```

   After that, admins manage roles from the app (`role` is `admin`, `sales` or `warehouse`).
   To lock someone out, set `active = false` rather than deleting the row.

## Run the tests

Needs any PostgreSQL 15+ server where you can create databases (not your Supabase project).

```bash
DATABASE_URL=postgres://postgres@localhost:5432/postgres scripts/test-db.sh
```

Expected last line: `ALL ACCEPTANCE TESTS PASSED`.

## How the rules are enforced

| Rule | Where |
|---|---|
| Stock is never stored, only derived from movements | `stock_view` |
| Movements can't be edited or deleted | `append_only` triggers (even for superusers) |
| Only RPCs write stock and sales; the browser has no INSERT on those tables | 0003 grants + 0002 `security definer` functions |
| Roles | RLS + a role check inside every RPC |
| No overselling, even with two phones at once | per-(product, location) advisory lock, checked server-side |
| Prices frozen at sale time; client can't set a price | `complete_sale` reads the catalog, copies to `sale_items` |
| Receipt numbers sequential, never reused | counter row inside the sale transaction; cancel is a soft `status` |
| Kit sale deducts the kit and each component × BOM qty | `kit_components` + `sale_requirements()` |
| Timestamps UTC, shown in Asia/Damascus | `timestamptz`; formatting is done in the app |

### RPCs

| Function | Roles | Notes |
|---|---|---|
| `receive_stock(product, location, qty, note)` | admin, warehouse | |
| `transfer_stock(product, from, to, qty, note)` | admin, warehouse | blocked if source is short |
| `stock_take(product, location, counted, note)` | admin, warehouse | writes the up/down adjustment; no difference → no row |
| `complete_sale(currency, tier, sold_from, items, customer_id, customer_name, client_ref)` | admin, sales | `items = [{"product_id": "...", "qty": 2}]`; `client_ref` (a UUID made on the phone) makes offline retries safe |
| `cancel_sale(sale_id, reason)` | admin | returns the units to where they left |

Errors start with a code before the colon so the UI can translate them:
`insufficient_stock` (the `DETAIL` lists every short item as JSON), `not_for_sale`, `no_price`,
`invalid_qty`, `invalid_transfer`, `empty_cart`, `already_cancelled`, `forbidden`, `last_admin`,
`append_only`, `nested_kit`.

## Changes from the master prompt

1. **Adjustments can subtract.** The spec's `stock_view` only ever added on `adjustment`, so a
   stock take that finds fewer units than the books was impossible. An adjustment now has either
   `to_location` (increase) or `from_location` (decrease); a CHECK constraint fixes the shape
   of every movement type. The view was rewritten around that rule.
2. **Kits use a `kit_components` table** (kit, component, qty) instead of `kit_parent_id`.
   One foreign key can't say "1 kit = 2 of this component". One level of nesting only.
3. **Gap-free receipt numbers.** A Postgres SEQUENCE skips numbers when a sale is rolled back
   (for example one blocked for low stock). A counter row updated inside the sale transaction doesn't.
4. **Wireless tier falls back to the general price** when a product has no wireless price.
5. Added columns: `specs`, `cost_usd` (needed for the valuation report), `reorder_level`
   (default 3), `sales.client_ref`, `sales.status/cancelled_*`, `sale_items.line_total`.
6. `sale_items` no longer cascades on delete: sales are never deleted.
7. The spec's acceptance example ("receive 10 → transfer 6 → transfer 4 → sell 2 shows 2/2/2")
   doesn't add up: 10 received and 2 sold leaves 8, not 6. The test uses
   warehouse→storage 6, then storage→display 4, then sells 2 from display → warehouse 4 / storage 2 / display 2.

## Notes for later steps

- The catalog CSV (~90 products) was not attached, so nothing real is seeded. Load it from the
  Import screen in step 2.
- A new function added in a later migration is executable by `anon`/`public` by default on
  Supabase. End such migrations with `revoke all on function ... from public, anon;` and grant
  to `authenticated` only what is needed.
- The JSON backup/restore (step 5) has to get around the append-only triggers on purpose; it will
  be an admin-only function that does so explicitly.
