#!/bin/sh
# Container entrypoint (Dockerfile ENTRYPOINT, after tini).
#
# Composes the database URLs from parts, then execs the command:
#
#   DATABASE_URL        from DB_USER / DB_PASSWORD           — the web task (veloapp)
#   ADMIN_DATABASE_URL  from DB_ADMIN_USER / DB_ADMIN_PASSWORD — the database task only
#
# with DB_HOST / DB_PORT / DB_NAME from the task definition. Users and passwords
# arrive from Secrets Manager at task start; the passwords are generated
# alphanumeric (infrastructure/cdk: SecurityStack app-db, DataStack master), so
# they go into the URL without escaping — and the entrypoint refuses one that is
# not, rather than building a URL that means something else.
#
# A URL already set wins: locally, in CI and in tests the app is configured with
# DATABASE_URL directly and none of this runs.
#
# TLS: sslmode=verify-full. Node checks Aurora's certificate against the RDS CA
# bundle the image carries (NODE_EXTRA_CA_CERTS, set in the task definition).
set -eu

compose() {
  user="$1"; pass="$2"
  case "$pass" in
    *[!A-Za-z0-9]*) echo "entrypoint: refusing a database password with characters outside [A-Za-z0-9]" >&2; exit 1 ;;
  esac
  printf 'postgres://%s:%s@%s:%s/%s?sslmode=verify-full' "$user" "$pass" "$DB_HOST" "${DB_PORT:-5432}" "$DB_NAME"
}

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ] && [ -n "${DB_USER:-}" ]; then
  DATABASE_URL="$(compose "$DB_USER" "${DB_PASSWORD:-}")"
  export DATABASE_URL
fi
if [ -z "${ADMIN_DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ] && [ -n "${DB_ADMIN_USER:-}" ]; then
  ADMIN_DATABASE_URL="$(compose "$DB_ADMIN_USER" "${DB_ADMIN_PASSWORD:-}")"
  export ADMIN_DATABASE_URL
fi
# The parts are not needed past this point; do not hand them to the app.
unset DB_PASSWORD DB_ADMIN_PASSWORD

exec "$@"
