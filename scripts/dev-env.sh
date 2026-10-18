# Source me FROM THE REPO ROOT:  . scripts/dev-env.sh
#
# Puts the local environment into the current shell. Every DB suite needs
# ADMIN_DATABASE_URL, the e2e also needs AUTH_SECRET, and a fresh terminal has
# neither — which reads as a broken setup ("database johnrim does not exist")
# rather than a missing export.
#
# Values are read LITERALLY rather than dot-sourced. `. .env.local` looks
# equivalent and is not: the shell parses each line, so a value containing < or >
# is a redirection and the whole file dies with "parse error near '\n'". Which is
# exactly what happens today, because AUTH_SECRET is still a placeholder.
#
# ADMIN_DATABASE_URL is deliberately NOT in .env.local — it is a superuser, and
# the app must never be able to read it — so it comes from HANDOFF.md's setup
# block. See HANDOFF §7 on moving both out of a tracked file.
if [ ! -f .env.local ] || [ ! -f HANDOFF.md ]; then
  echo "dev-env: source me from the repo root (.env.local and HANDOFF.md not found here)" >&2
  return 1 2>/dev/null || exit 1
fi

while IFS= read -r __line || [ -n "$__line" ]; do
  case "$__line" in '' | '#'*) continue ;; esac
  __key=${__line%%=*}
  __val=${__line#*=}
  # Only plain variable names; anything else is a comment or a continuation.
  case "$__key" in '' | *[!A-Za-z0-9_]*) continue ;; esac
  # Strip one layer of surrounding quotes if present.
  case "$__val" in
    \"*\") __val=${__val#\"}; __val=${__val%\"} ;;
    \'*\') __val=${__val#\'}; __val=${__val%\'} ;;
  esac
  export "$__key=$__val"
done < .env.local
unset __line __key __val

eval "$(grep -E '^export ADMIN_DATABASE_URL=' HANDOFF.md)"

: "${DATABASE_URL:?dev-env: DATABASE_URL missing from .env.local}"
: "${ADMIN_DATABASE_URL:?dev-env: ADMIN_DATABASE_URL not found in HANDOFF.md}"

# A warning, not a failure: the vitest suites do not need AUTH_SECRET, only the
# Playwright e2e does (e2e/auth.setup.ts mints the session cookie with it).
case "${AUTH_SECRET:-}" in
  '' | *'<'* | *'>'*)
    echo "dev-env: WARNING — AUTH_SECRET in .env.local is unset or still a placeholder." >&2
    echo "dev-env:   npm test / build / typecheck are fine; 'npm run e2e' will fail." >&2
    echo "dev-env:   Generate one:  openssl rand -base64 32" >&2
    ;;
esac

# VX2-8. Both have documented off states, so these are conveniences rather than
# requirements — but without APP_URL every notification email goes out with no
# links at all, which is the exact ExpenseOS failure GAP-AUDIT NT-14 records, and
# it is silent. Default them for local work and leave the deployed values to the
# deployment.
: "${APP_URL:=http://localhost:3000}"
export APP_URL
# 18 Oct 2026: /signup is closed unless SIGNUP_ENABLED=true (lib/onboarding/signupGate.ts).
# Local development keeps it open, as dev does; production does not.
: "${SIGNUP_ENABLED:=true}"
export SIGNUP_ENABLED
: "${WORKER_SECRET:=dev-only-not-a-secret}"
export WORKER_SECRET
# SMTP_HOST is deliberately NOT defaulted: unset means the console transport, so
# mail is written to the server log and nothing leaves the machine. That is the
# right local default and setting it by accident is not.

echo "dev-env ready: $(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]*:)[^@]*(@)#\1***\2#')"
echo "dev-env   mail: ${SMTP_HOST:+SMTP $SMTP_HOST}${SMTP_HOST:-console transport (nothing sent)}"
