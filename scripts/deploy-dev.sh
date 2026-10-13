#!/usr/bin/env bash
# Deploy a commit of VeloExpense to dev (dev.veloexpense.ai), start to finish.
#
#   scripts/deploy-dev.sh                      deploy origin/main
#   scripts/deploy-dev.sh 7d48c73              deploy that commit
#   scripts/deploy-dev.sh --restart-worker     also restart the worker after migrating
#
#   APK_REPO_SCHEME=http scripts/deploy-dev.sh
#       on a network that re-signs TLS to the Alpine package mirror (John's Mac, behind
#       E Inc's Cloudflare Gateway). The Dockerfile says what that trades away and why
#       it is still safe; this only passes it through.
#
# What it does, in the order a deploy needs:
#   1. checks the AWS sign-in is for the Velotech account (and offers `aws sso login`);
#   2. fetches, and resolves the commit to a 7-character tag;
#   3. builds the image from a CLEAN checkout of that commit (a temporary git worktree,
#      removed on exit), so nothing uncommitted in your working copy is ever shipped;
#      skipped when ECR already holds that tag (tags are immutable there);
#   4. pushes it to ECR;
#   5. `cdk deploy --all` with IMAGE_TAG set (CDK still asks before any IAM or
#      security-group change; read it before saying yes);
#   6. runs the database task (bootstrap + migrations), waits for it, prints its log,
#      and stops with an error if it did not exit 0;
#   7. with --restart-worker, restarts the worker and prints its approval-sweep lines —
#      for a deploy whose worker must start AFTER the migration (w4-00c's was one).
#
# Written from the deploy of 12-13 Oct 2026 (#211-#213), which was done by hand.
# The account, region and names come from infrastructure/cdk/lib/config.ts and
# compute-stack.ts; test/deploy-dev-script.test.ts fails if they drift apart.
#
# Plain bash 3.2 (macOS's): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

ACCOUNT_ID="535079144866"
REGION="ca-central-1"
REPOSITORY="veloexpense-dev/web"
STACK="VeloExpense-Dev-Compute"
DB_LOG_GROUP="/ecs/veloexpense-dev/db"
WORKER_LOG_GROUP="/ecs/veloexpense-dev/worker"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

REF="origin/main"
RESTART_WORKER=0
for arg in "$@"; do
  case "$arg" in
    --restart-worker) RESTART_WORKER=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "deploy-dev: unknown option $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done

APK_REPO_SCHEME="${APK_REPO_SCHEME:-https}"
case "$APK_REPO_SCHEME" in
  https|http) ;;
  *) echo "deploy-dev: APK_REPO_SCHEME must be https or http" >&2; exit 2 ;;
esac

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\ndeploy-dev: %s\n' "$*" >&2; exit 1; }

for tool in git aws docker npm npx; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed or not on PATH"
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# ── 1. AWS sign-in ────────────────────────────────────────────────────────────
step "AWS sign-in"
account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ "$account" != "$ACCOUNT_ID" ]; then
  echo "Not signed in to account $ACCOUNT_ID (got: ${account:-nothing}). Running aws sso login."
  aws sso login
  account="$(aws sts get-caller-identity --query Account --output text)"
  [ "$account" = "$ACCOUNT_ID" ] || die "signed in to $account, not $ACCOUNT_ID"
fi
echo "account $account"

# ── 2. The commit ─────────────────────────────────────────────────────────────
step "Commit"
git fetch --quiet origin
SHA="$(git rev-parse --verify --quiet "${REF}^{commit}")" || die "no such commit: $REF"
TAG="$(git rev-parse --short=7 "$SHA")"
git log --oneline -1 "$SHA"

# ── 3-4. Image ────────────────────────────────────────────────────────────────
IMAGE="${REGISTRY}/${REPOSITORY}:${TAG}"
WORKTREE=""
cleanup() {
  if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    rmdir "$(dirname "$WORKTREE")" 2>/dev/null || true
  fi
}
trap cleanup EXIT

WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/veloexpense-deploy.XXXXXX")/${TAG}"
git worktree add --quiet --detach "$WORKTREE" "$SHA"

if aws ecr describe-images --region "$REGION" --repository-name "$REPOSITORY" \
     --image-ids "imageTag=${TAG}" >/dev/null 2>&1; then
  step "Image ${TAG} is already in ECR; not rebuilding"
else
  step "Build ${IMAGE} (APK_REPO_SCHEME=${APK_REPO_SCHEME})"
  docker build --platform linux/arm64 --provenance=false --sbom=false \
    --build-arg "APK_REPO_SCHEME=${APK_REPO_SCHEME}" -t "$IMAGE" "$WORKTREE"
  step "Push"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"
  docker push "$IMAGE"
fi

# ── 5. CDK ────────────────────────────────────────────────────────────────────
step "cdk deploy (IMAGE_TAG=${TAG})"
(
  cd "$WORKTREE/infrastructure/cdk"
  npm ci --no-audit --no-fund
  VELOEXPENSE_STAGE=dev IMAGE_TAG="$TAG" npx cdk deploy --all
)

# ── 6. Migrations ─────────────────────────────────────────────────────────────
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
CLUSTER="$(output ClusterName)"
FAMILY="$(output DbTaskFamily)"
SUBNETS="$(output TaskSubnets)"
SG="$(output TaskSecurityGroup)"
WORKER="$(output WorkerServiceName)"
[ -n "$CLUSTER" ] && [ -n "$FAMILY" ] && [ -n "$SUBNETS" ] && [ -n "$SG" ] \
  || die "could not read the $STACK outputs"

step "Migrations ($FAMILY)"
TASK="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$FAMILY" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
[ -n "$TASK" ] && [ "$TASK" != "None" ] || die "the database task did not start"
echo "$TASK"
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK"
EXIT_CODE="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
aws logs tail "$DB_LOG_GROUP" --region "$REGION" --since 15m \
  --log-stream-name-prefix "db/db/${TASK##*/}" || true
[ "$EXIT_CODE" = "0" ] || die "the database task exited ${EXIT_CODE}; nothing after it was done"

# ── 7. Worker ─────────────────────────────────────────────────────────────────
if [ "$RESTART_WORKER" = "1" ]; then
  step "Restart the worker ($WORKER)"
  aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$WORKER" \
    --force-new-deployment --query service.serviceName --output text
  aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$WORKER"
  sleep "${WORKER_SETTLE_SECONDS:-30}"
  aws logs tail "$WORKER_LOG_GROUP" --region "$REGION" --since 10m \
    --filter-pattern '"approval.sweep"' || true
fi

step "Deployed ${TAG} to dev"
