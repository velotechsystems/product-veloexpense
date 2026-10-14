// @vitest-environment node
/**
 * scripts/deploy-dev.sh — the dev deploy, written down after 12-13 Oct 2026's was done by hand.
 *
 * Two halves:
 *   · its constants are the infrastructure's (account, region, repository, stack, log groups),
 *     read from infrastructure/cdk so a rename there fails here rather than at the next deploy;
 *   · it RUNS, against stand-ins for aws, docker, npm and npx on PATH that record every call:
 *     the order of a deploy, the clean checkout it builds from, the migration's exit code
 *     stopping it, and the worker restart only when asked for.
 *
 * Nothing here reaches AWS or Docker.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = readFileSync('scripts/deploy-dev.sh', 'utf8');
const value = (name: string) => SCRIPT.match(new RegExp(`^${name}="([^"]+)"`, 'm'))?.[1];

describe('deploy-dev.sh names what the infrastructure names', () => {
  const config = readFileSync('infrastructure/cdk/lib/config.ts', 'utf8');
  const compute = readFileSync('infrastructure/cdk/lib/compute-stack.ts', 'utf8');
  const storage = readFileSync('infrastructure/cdk/lib/storage-stack.ts', 'utf8');
  const app = readFileSync('infrastructure/cdk/bin/app.ts', 'utf8');

  it('the account and region', () => {
    expect(config).toContain(`const ACCOUNT_ID = '${value('ACCOUNT_ID')}'`);
    expect(config).toContain(`const REGION = '${value('REGION')}'`);
  });

  it('the repository, the stack and the log groups, for the dev prefix', () => {
    expect(config).toContain('resourcePrefix: `veloexpense-${stage}`');
    expect(storage).toContain('repositoryName: `${prefix}/web`');
    expect(value('REPOSITORY')).toBe('veloexpense-dev/web');
    expect(app).toContain('const prefix = `VeloExpense-${pascal(config.stage)}`');
    expect(app).toContain('`${prefix}-Compute`');
    expect(value('STACK')).toBe('VeloExpense-Dev-Compute');
    expect(compute).toContain('logGroupName: `/ecs/${prefix}/${name}`');
    expect(compute).toContain("logGroup('DbLogs', 'db')");
    expect(value('DB_LOG_GROUP')).toBe('/ecs/veloexpense-dev/db');
    expect(value('WORKER_LOG_GROUP')).toBe('/ecs/veloexpense-dev/worker');
  });

  it('the stack outputs it reads', () => {
    for (const key of ['ClusterName', 'DbTaskFamily', 'TaskSubnets', 'TaskSecurityGroup', 'WorkerServiceName']) {
      expect(compute, key).toContain(`new CfnOutput(this, '${key}'`);
      expect(SCRIPT, key).toContain(`output ${key}`);
    }
  });
});

/* ── running it, against stand-ins ───────────────────────────────────────────── */

const FAKE_AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$CALLS"
case "$*" in
  "sts get-caller-identity"*) echo "\${FAKE_ACCOUNT:-535079144866}" ;;
  "sso login"*) ;;
  *"ecr describe-images"*) exit "\${FAKE_IMAGE_EXISTS:-1}" ;;
  *"ecr get-login-password"*) echo pw ;;
  *"cloudformation describe-stacks"*)
    case "$*" in
      *ClusterName*) echo velotech-dev-cluster ;;
      *DbTaskFamily*) echo veloexpense-dev-db ;;
      *TaskSubnets*) echo subnet-a,subnet-b ;;
      *TaskSecurityGroup*) echo sg-1 ;;
      *WorkerServiceName*) echo veloexpense-dev-worker ;;
    esac ;;
  *"ecs run-task"*) echo arn:aws:ecs:ca-central-1:1:task/velotech-dev-cluster/abc123 ;;
  *"ecs describe-tasks"*) echo "\${FAKE_EXIT:-0}" ;;
  *"logs tail"*) echo "migrate OK" ;;
  *"ecs update-service"*) echo veloexpense-dev-worker ;;
esac
`;
const RECORDER = (name: string) => `#!/usr/bin/env bash
echo "${name} $*  [in $(pwd)]" >> "$CALLS"
cat >/dev/null 2>&1 || true
`;

let dir: string;
let repo: string;
let calls: string;
let bin: string;

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'deploy-dev-'));
  repo = path.join(dir, 'repo');
  bin = path.join(dir, 'bin');
  calls = path.join(dir, 'calls.log');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(path.join(repo, 'infrastructure', 'cdk'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(repo, 'scripts', 'deploy-dev.sh'), SCRIPT, { mode: 0o755 });
  writeFileSync(path.join(repo, 'infrastructure', 'cdk', 'package.json'), '{}');
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  git('remote', 'add', 'origin', repo);
  writeFileSync(path.join(bin, 'aws'), FAKE_AWS);
  for (const name of ['docker', 'npm', 'npx']) writeFileSync(path.join(bin, name), RECORDER(name));
  for (const name of ['aws', 'docker', 'npm', 'npx']) chmodSync(path.join(bin, name), 0o755);
  writeFileSync(calls, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deploy(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['scripts/deploy-dev.sh', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, TMPDIR: dir, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
}

const tag = () => execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const index = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle));

describe('deploy-dev.sh, run', () => {
  it('builds from a clean checkout, pushes, deploys, then migrates — in that order', () => {
    const r = deploy([], { APK_REPO_SCHEME: 'http' });
    expect(r.status, r.out).toBe(0);
    const t = tag();
    const build = r.calls.find((l) => l.startsWith('docker build'))!;
    expect(build).toContain(`535079144866.dkr.ecr.ca-central-1.amazonaws.com/veloexpense-dev/web:${t}`);
    expect(build).toContain('--platform linux/arm64');
    expect(build).toContain('APK_REPO_SCHEME=http');
    // The build context is a throwaway worktree of the commit, not the working copy.
    expect(build).toMatch(new RegExp(`veloexpense-deploy\\.\\w+/${t}  \\[in`));
    expect(build).not.toContain(` ${repo}  [in`);

    const order = [
      'sts get-caller-identity',
      'ecr describe-images',
      'docker build',
      'docker push',
      'npm ci',
      `npx cdk deploy --all`,
      'ecs run-task',
      'ecs wait tasks-stopped',
      'ecs describe-tasks',
      'logs tail /ecs/veloexpense-dev/db',
    ].map((n) => index(r.calls, n));
    expect(order.every((i) => i >= 0), r.calls.join('\n')).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.calls.find((l) => l.startsWith('npx cdk'))).toContain('/infrastructure/cdk]');
    expect(r.calls.some((l) => l.includes('ecs run-task') && l.includes('subnets=[subnet-a,subnet-b]'))).toBe(true);
    // No restart unless asked for.
    expect(index(r.calls, 'update-service')).toBe(-1);
    // And the worktree is gone afterwards.
    expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('builds with https unless told otherwise', () => {
    const r = deploy();
    expect(r.status, r.out).toBe(0);
    expect(r.calls.find((l) => l.startsWith('docker build'))).toContain('APK_REPO_SCHEME=https');
  });

  it('does not rebuild a tag ECR already holds', () => {
    const r = deploy([], { FAKE_IMAGE_EXISTS: '0' });
    expect(r.status, r.out).toBe(0);
    expect(index(r.calls, 'docker build')).toBe(-1);
    expect(index(r.calls, 'docker push')).toBe(-1);
    expect(index(r.calls, 'cdk deploy')).toBeGreaterThan(-1);
  });

  it('stops on a failed migration, and does not restart the worker', () => {
    const r = deploy(['--restart-worker'], { FAKE_EXIT: '1', WORKER_SETTLE_SECONDS: '0' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the database task exited 1');
    expect(index(r.calls, 'update-service')).toBe(-1);
  });

  it('restarts the worker after the migration when asked', () => {
    const r = deploy(['--restart-worker'], { WORKER_SETTLE_SECONDS: '0' });
    expect(r.status, r.out).toBe(0);
    expect(index(r.calls, 'update-service')).toBeGreaterThan(index(r.calls, 'ecs describe-tasks'));
    expect(index(r.calls, 'logs tail /ecs/veloexpense-dev/worker')).toBeGreaterThan(-1);
  });

  it('refuses the wrong AWS account', () => {
    const r = deploy([], { FAKE_ACCOUNT: '111111111111' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('not 535079144866');
    expect(index(r.calls, 'docker')).toBe(-1);
  });

  it('refuses a commit that does not exist', () => {
    const r = deploy(['deadbeef']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no such commit: deadbeef');
  });

  it('leaves no temporary checkout behind', () => {
    deploy();
    expect(existsSync(path.join(dir, 'repo', '.git', 'worktrees'))
      ? execFileSync('ls', [path.join(repo, '.git', 'worktrees')], { encoding: 'utf8' }).trim()
      : '').toBe('');
  });
});
