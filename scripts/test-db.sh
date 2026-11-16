#!/usr/bin/env bash
# Build a throwaway database, apply the Supabase stand-in + migrations, run
# the acceptance tests. Needs a PostgreSQL 15+ server you can create
# databases on.   Usage: DATABASE_URL=postgres://user@host:5432/postgres scripts/test-db.sh
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a superuser connection on a scratch server}"
root="$(cd "$(dirname "$0")/.." && pwd)"
db="sam_test_$$"

admin() { psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" "$@"; }
admin -c "create database $db"
trap 'admin -c "drop database if exists $db with (force)" >/dev/null' EXIT

# Same server, different database name
url="${DATABASE_URL%/*}/$db"
run() { psql -v ON_ERROR_STOP=1 -q "$url" "$@"; }

run -f "$root/supabase/tests/00_local_shim.sql"
for f in "$root"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  run -f "$f"
done
run -f "$root/supabase/tests/bootstrap.sql"      # needs a database with no staff yet
run -f "$root/supabase/seed.sql"          # the dev seed must load cleanly too
run -c "delete from public.kit_components; delete from public.products;"   # tests need a clean catalog
run -f "$root/supabase/tests/acceptance.sql"
