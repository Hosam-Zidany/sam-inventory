# SAM Inventory & Receipts

Bilingual (English / Arabic, RTL) inventory and digital-receipt app for SAM Company.
Stack: Next.js + Tailwind/shadcn · Supabase (Postgres, Auth, RLS) · Vercel.

**Status: build steps 1–4 in progress** — database, roles, RLS; app shell, login, Products
and CSV import; stock receiving/transfers/counts; dashboard and sales/receipts are available.
Movements, reports, PWA/offline queue and barcode scanning remain for later steps.

The app is a **static export** (no server of its own): the browser talks straight to Supabase,
and every rule is enforced by Postgres. That is what lets it be hosted free on GitHub Pages.

## Quick start — everything from a phone browser (no laptop)

1. **GitHub → repo → Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Then **Actions → "Deploy to GitHub Pages" → Run workflow** (or just push). The site goes live at
   `https://<user>.github.io/<repo>/` (about 2 minutes).
2. **supabase.com → New project** (note the database password; any region near you).
3. In the project: **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql), **Run**.
4. **Authentication → Users → Add user → Create new user**, enter your email + a password, tick *Auto Confirm User*.
   **Authentication → Sign In / Providers → Email → turn OFF "Allow new users to sign up"** so strangers cannot create accounts.
5. **Project Settings → API** → copy the **Project URL** and the **anon / publishable key** (never the secret / service_role key).
6. Open your site → paste both values on the setup screen → sign in with the user from step 4 →
   press **"Make me the admin"** (shown only while the project has no admin).
7. **Import / Export** → upload your catalog CSV.

More staff: Authentication → Add user, then in the SQL editor
`insert into public.staff_roles (user_id, role) select id, 'sales' from auth.users where email = 'x@y.com';`
(roles: `admin`, `sales`, `warehouse`). An in-app user manager comes in a later step.

The connection values are saved in the browser you used (the anon key is public by design; row-level
security is what protects the data). Alternatively set the repo variables `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` once and every browser is pre-connected.

## What is in step 1

```
supabase/
  migrations/
    0001_schema.sql      tables, derived stock view, append-only triggers
    0002_functions.sql   receive_stock, transfer_stock, stock_take, complete_sale, cancel_sale
    0003_rls.sql         grants + row-level security per role
    0004_import_products.sql  atomic catalog import (admin only)
    0005_claim_first_admin.sql  first signed-in user may become admin, only while none exists
  setup.sql              all migrations in one paste-able file (scripts/build-setup-sql.sh)
  seed.sql               local-dev placeholder products (never run on db push)
  tests/
    00_local_shim.sql    stand-in for Supabase's auth schema, for plain Postgres
    acceptance.sql       71 checks, runs in a transaction and rolls back
scripts/test-db.sh       builds a scratch DB, applies everything, runs the tests
src/                     Next.js app (i18n ar/en, auth, Products, Import)
messages/                en.json + ar.json (npm run check:i18n keeps them in sync)
.github/workflows/       ci.yml (checks) + deploy.yml (GitHub Pages)
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

## Run the app locally

```bash
cp .env.example .env.local      # fill in your Supabase URL + anon key
npm install
npm run dev                     # http://localhost:3000  (redirects to /ar/)
```

Sign in with a user you gave a role (see Setup, step 3). Admin sees Products and Import / Export;
sales and warehouse see Products read-only. Admin and warehouse staff can receive, transfer and
count stock; admin and sales staff can create sales. The database refuses unauthorized writes
regardless of the UI.

Admins can change the central SYP-per-USD rate from Products. SYP prices are recalculated from
the USD price, and the Products screen also has a destructive “Clear catalog + history” action
for starting over; it keeps staff accounts but removes products, stock, sales, customers and the
receipt counter history.

## Host on GitHub Pages

1. Push this repo to GitHub (public repo for the free plan).
2. **Settings → Pages → Source: GitHub Actions.**
3. *(Optional)* **Settings → Secrets and variables → Actions → Variables** → add
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to pre-connect every browser.
   Without them the site shows a setup screen instead. These are *variables*, not secrets: the anon key
   is public by design and ships in the browser. Never put the `service_role` key anywhere.
4. Push to `main`. The workflow runs all tests, builds, and publishes to
   `https://<user>.github.io/<repo>/`. Add `NEXT_PUBLIC_BASE_PATH` as a variable only for a custom domain (set it empty).
5. In Supabase → **Authentication → URL Configuration**, add the site URL above.

## Run the tests

```bash
npm test               # import/validation logic (31 tests)
npm run typecheck
npm run check:i18n
scripts/test-db.sh     # database acceptance tests (needs DATABASE_URL, see below)
```

Database tests:

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
| `import_products(rows)` | admin | all-or-nothing upsert by `item_code`; keys missing from a row are left untouched |

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

## Import behaviour (step 2)

- Both CSV formats from the spec are detected from the header row; UTF-8 and Windows-1256 (Arabic Excel) files both work, as do `;`-separated files.
- Item codes may be left blank in the simple and Price List / Section templates; the importer assigns unique `AUTO-0001`-style codes. Exported catalogs always include the assigned codes so they can be re-imported safely.
- Preview first, nothing is saved until **Import**. Rows without a code/name, duplicate codes or barcodes in the file, and barcodes already owned by another product are **skipped** and shown in red.
- Warnings (imported, but check them): SYP/USD ratio more than 15% from the file's median; wireless price higher than general; prices that are text (`ضمن الطقم`, `طقم مع الصحن (65700)`) are stored as "no standalone price" (general 0, wireless empty); barcodes ruined by Excel's scientific notation are dropped.
- The PDF format has one column for code *and* name, so the code is used as the name; add `name_ar` later with the template. A length such as `305m` in `Unit_or_Length` goes to Specs, not Unit.
- The PDF format never changes `for_sale`: re-importing a price list will not switch products on or off.
- Only changed fields are sent for existing products, so an import cannot overwrite things like barcode or Arabic name unless the file says so.

## Notes for later steps

- The catalog CSV (~90 products) was not attached, so nothing real is seeded. Load it from the
  Import screen in step 2.
- A new function added in a later migration is executable by `anon`/`public` by default on
  Supabase. End such migrations with `revoke all on function ... from public, anon;` and grant
  to `authenticated` only what is needed.
- The JSON backup/restore (step 5) has to get around the append-only triggers on purpose; it will
  be an admin-only function that does so explicitly.
