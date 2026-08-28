# Source me: `. scripts/dev-env.sh`
#
# Puts the whole local environment into the current shell. Every DB suite needs
# ADMIN_DATABASE_URL, the e2e ALSO needs AUTH_SECRET, and a fresh terminal has
# neither — which has now cost three round trips of "database johnrim does not
# exist" and "AUTH_SECRET must be set", each of which reads like a broken setup
# rather than a missing export.
#
# .env.local carries everything the app needs. ADMIN_DATABASE_URL is deliberately
# NOT in it — it is a superuser, and the app must never be able to read it — so it
# comes from HANDOFF.md's setup block. See HANDOFF §7 on moving both out of a
# tracked file; until that happens, this is where the knowledge lives.
set -a
. "$(dirname "${BASH_SOURCE[0]:-$0}")/../.env.local"
set +a
eval "$(grep -E '^export ADMIN_DATABASE_URL=' "$(dirname "${BASH_SOURCE[0]:-$0}")/../HANDOFF.md")"
: "${DATABASE_URL:?DATABASE_URL missing from .env.local}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL not found in HANDOFF.md}"
: "${AUTH_SECRET:?AUTH_SECRET missing from .env.local}"
echo "dev env ready: $(echo "$DATABASE_URL" | sed -E 's#(://[^:]*:)[^@]*(@)#\1***\2#')"
