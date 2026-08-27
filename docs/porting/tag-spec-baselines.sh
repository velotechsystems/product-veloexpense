#!/usr/bin/env bash
#
# Spec-baseline tags for the VeloExpense port (Port & Build Plan §6).
#
# RUN THIS FROM AN EXPENSEOS CHECKOUT, not from product-veloexpense:
#
#   cd ~/ExpenseOS && git fetch origin && \
#     bash ~/code/velotechsystems/product-veloexpense/docs/porting/tag-spec-baselines.sh
#
# Chained with && on purpose: pasted as separate lines, a failed `cd` lets the
# shell carry on and `git fetch origin` hits whatever repo you happened to be in.
# (The clone is at ~/ExpenseOS, NOT ~/code/ExpenseOS — ~/code holds only
# velotechsystems.)
#
# Optional args: [BASELINE_SHA] [YYYYMMDD]
#
# Why this exists. The plan asks that every ported module record the ExpenseOS
# commit it was based on, so that catching later ExpenseOS changes is
#
#     git diff <baseline>..origin/main -- <module paths>
#
# rather than a memory exercise. Ten Phase-1 tickets plus VX2-1 shipped with no
# tags at all, so this backfills them at one defensible baseline; from here each
# module's tag moves forward independently as it is re-synced.
#
# WHY ONE SHARED BASELINE, AND WHY IT IS DELIBERATELY EARLY. We cannot
# reconstruct a per-module sha after the fact. fb1cead is the commit the Port &
# Build Plan names as the basis of its ExpenseOS functionality audit
# (2026-08-22); Phase 1 was ported 2026-08-24..26 against module docs that
# claim "verified against code 2026-08-14". So fb1cead is at or before every
# port. That direction of error is the safe one: an early baseline makes the
# delta diff show a few changes that were already incorporated (noise), while a
# late one hides changes that were never ported (a silent gap).
#
# Dry run first — it prints everything and writes nothing:
#   DRY_RUN=1 bash tag-spec-baselines.sh
# Works on macOS's stock bash 3.2 — no mapfile, no associative arrays.
set -euo pipefail

BASELINE="${1:-fb1cead}"
STAMP="${2:-20260827}"
DRY_RUN="${DRY_RUN:-0}"
# A baseline is a fixed record of what a module was ported from. Moving one
# silently is exactly the failure that destroys the delta log's value, so an
# existing tag pointing at a DIFFERENT commit aborts the run unless FORCE=1.
# Re-running against the same commit is a no-op either way.
FORCE="${FORCE:-0}"
TAG_PREFIX="veloexpense-spec"

# module-slug : space-separated FILE BASENAMES that make up the module's spec.
# Basenames rather than paths because ExpenseOS's layout is not recorded here —
# the script resolves real paths from `git ls-files`, and prints what it found so
# SPEC-BASELINES.md can be filled in from reality rather than from a guess.
#
# ONLY MODULES ALREADY PORTED ARE TAGGED. `audit` (VX2-6) and `notifications`
# (VX2-7/8) are deliberately absent: tagging them at fb1cead would claim we
# ported from a commit we have not read. They get a baseline at the commit that
# is current WHEN their ticket lands — which matters especially here, because a
# 654-file update landed on ExpenseOS main recently (travel build-out, NetSuite
# posting, notification template-key changes), so notifications in particular
# must be ported from current main, not from August.
MODULE_SLUGS=(
  reference-data
  employees-org
  expense-reports
  receipts
  policy-engine
  approvals
)
MODULE_FILES=(
  "expenseCategories.ts legalEntities.ts businessUnits.ts departments.ts"
  "users.ts roles.ts adminLookup.ts"
  "expenses.ts"
  "expenses.ts"
  "policies.ts"
  "expenseApprovals.ts approvalWorkflows.ts delegations.ts"
)
MODULE_TICKETS=(
  "VX1-1 (PR #10)"
  "VX1-2 (PR #13)"
  "VX1-3 (PR #11), VX1-4 (PR #12), VX1-8 (PR #18)"
  "VX1-5 (PR #14), VX1-6 (PR #15), VX1-10 (PR #20)"
  "VX1-7 (PR #17)"
  "VX2-1 (PR #22, #23)"
)

# ── sanity ───────────────────────────────────────────────────────────────────
git rev-parse --git-dir >/dev/null 2>&1 || { echo "ERROR: not inside a git repo." >&2; exit 1; }
if ! git ls-files | grep -qE '/(expenses|policies)\.ts$'; then
  echo "ERROR: this does not look like the ExpenseOS repo (no expenses.ts / policies.ts)." >&2
  echo "       cd into your ExpenseOS checkout and re-run." >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "${BASELINE}^{commit}" >/dev/null; then
  echo "ERROR: baseline '$BASELINE' is not a commit in this repo." >&2
  echo "       Fetch first (git fetch origin), or pass a sha you do have." >&2
  exit 1
fi
FULL_SHA="$(git rev-parse "${BASELINE}^{commit}")"
SHORT_SHA="$(git rev-parse --short "${BASELINE}^{commit}")"
BASE_DATE="$(git show -s --format=%cs "$FULL_SHA")"

echo "ExpenseOS repo : $(git rev-parse --show-toplevel)"
# There appear to be TWO ExpenseOS checkouts: ~/ExpenseOS, and the Google-Drive
# folder ".../PeopleOS HRIS System/ExpenseOS", which the GA-audit handoff states
# IS a clone of carmigo/ExpenseOS. Tags created here exist only in THIS clone
# until pushed. Push them, or a future `git diff <baseline>..origin/main` run
# from the other checkout will not find them.
echo "                 ^ tags land in THIS clone only until pushed — see note above"
echo "Baseline       : $SHORT_SHA  ($BASE_DATE)"
echo "Tag stamp      : $STAMP"
echo "Mode           : $([ "$DRY_RUN" = 1 ] && echo 'DRY RUN — nothing will be written' || echo 'WRITING TAGS')"
echo

TABLE_ROWS=""
FAILED=0
for i in "${!MODULE_SLUGS[@]}"; do
  slug="${MODULE_SLUGS[$i]}"
  names="${MODULE_FILES[$i]}"
  ticket="${MODULE_TICKETS[$i]}"
  tag="${TAG_PREFIX}/${slug}-${STAMP}"

  # Resolve basenames -> real repo paths. A read loop rather than `mapfile`,
  # because macOS ships bash 3.2 and mapfile is a bash 4 builtin.
  pattern="$(echo "$names" | tr ' ' '\n' | sed 's/\./\\./g' | paste -sd'|' -)"
  paths=()
  while IFS= read -r line; do
    [ -n "$line" ] && paths+=("$line")
  done < <(git ls-files | grep -E "/(${pattern})$" || true)

  echo "── ${slug}"
  if [ "${#paths[@]}" -eq 0 ]; then
    echo "   !! no files matched (${names}) — module may be named differently; skipping tag"
    echo
    continue
  fi
  printf '   %s\n' "${paths[@]}"

  # Refuse to move an existing baseline unless told to.
  existing=""
  if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
    existing="$(git rev-parse "refs/tags/${tag}^{commit}")"
  fi
  if [ -n "$existing" ] && [ "$existing" != "$FULL_SHA" ] && [ "$FORCE" != 1 ]; then
    echo "   !! $tag already points at $(git rev-parse --short "$existing")," >&2
    echo "      not $SHORT_SHA. Moving a baseline loses the record of what was" >&2
    echo "      actually ported. Re-run with FORCE=1 if that is deliberate." >&2
    FAILED=1
    echo
    continue
  fi

  if [ "$DRY_RUN" != 1 ]; then
    git tag -f -a "$tag" "$FULL_SHA" -m "VeloExpense spec baseline for the ${slug} module.
Ported by: ${ticket}
Re-sync with: git diff ${tag}..origin/main -- <paths above>"
    if [ -n "$existing" ]; then echo "   re-tagged (same commit): $tag"; else echo "   tagged: $tag"; fi
  else
    echo "   would tag: $tag"
  fi
  echo

  joined="$(printf '%s<br>' "${paths[@]}")"
  TABLE_ROWS="${TABLE_ROWS}| \`${slug}\` | ${ticket} | \`${tag}\` | ${joined%<br>} |
"
done

echo "════════════════════════════════════════════════════════════════"
if [ "$DRY_RUN" != 1 ]; then
  echo "Push the tags, or they exist only in this clone. Namespaced, NOT --tags,"
  echo "which would push every stray local tag in this clone up to carmigo/ExpenseOS:"
  echo "    git push origin 'refs/tags/${TAG_PREFIX}/*'"
  echo
fi
echo "Paste these rows into product-veloexpense/docs/porting/SPEC-BASELINES.md:"
echo
echo "| Module | Ported by | Baseline tag | ExpenseOS paths |"
echo "| --- | --- | --- | --- |"
printf '%s' "$TABLE_ROWS"

if [ "${FAILED:-0}" != 0 ]; then
  echo
  echo "One or more baselines were REFUSED (see !! above). Nothing else was changed." >&2
  exit 1
fi
