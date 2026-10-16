// @vitest-environment node
/**
 * .github/workflows/cd.yml — the CD workflow ported from ExpenseOS.
 *
 * VeloExpense's own checks (ExpenseOS has no test for its cd.yml). Like
 * deploy-dev-script.test.ts, they fail here, at review, for the ways the workflow could be
 * wrong and still be valid YAML:
 *   · the role it assumes is not the one deploy-role-stack.ts creates;
 *   · a job that signs in to AWS does not declare the environment, so GitHub presents a
 *     subject the role does not trust (or, worse, the trust is widened to make it work);
 *   · the workflow_run gate lets a fork's pull request through;
 *   · its names drift from scripts/deploy-dev.sh and the CDK.
 *
 * Nothing here reaches GitHub or AWS.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CD = readFileSync('.github/workflows/cd.yml', 'utf8');
const DEPLOY_DEV = readFileSync('scripts/deploy-dev.sh', 'utf8');
const ROLE_STACK = readFileSync('infrastructure/cdk/lib/deploy-role-stack.ts', 'utf8');
const CONFIG = readFileSync('infrastructure/cdk/lib/config.ts', 'utf8');
const COMPUTE = readFileSync('infrastructure/cdk/lib/compute-stack.ts', 'utf8');

/** A top-level `env:` value of the workflow. */
const envValue = (name: string) => CD.match(new RegExp(`^  ${name}: (.+)$`, 'm'))?.[1]?.trim();
/** A constant of deploy-dev.sh. */
const scriptValue = (name: string) => DEPLOY_DEV.match(new RegExp(`^${name}="([^"]+)"`, 'm'))?.[1];

/** Each job's text, keyed by its id (the two-space-indented keys under `jobs:`). */
function jobs(): Record<string, string> {
  const body = CD.slice(CD.indexOf('\njobs:\n'));
  const parts = body.split(/^ {2}([a-z][a-z-]*):\n/m).slice(1);
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

describe('cd.yml assumes the role deploy-role-stack.ts creates', () => {
  it('in this account, by its per-stage name', () => {
    const account = CONFIG.match(/const ACCOUNT_ID = '(\d+)'/)?.[1];
    expect(ROLE_STACK).toContain('roleName: `${prefix}-deploy-role`');
    expect(CONFIG).toContain('resourcePrefix: `veloexpense-${stage}`');
    expect(envValue('CD_ROLE_ARN')).toBe(`arn:aws:iam::${account}:role/veloexpense-dev-deploy-role`);
  });

  it('and the role trusts exactly this repository’s environment subject', () => {
    expect(CONFIG).toContain("export const GITHUB_REPOSITORY = 'velotechsystems/product-veloexpense'");
    expect(ROLE_STACK).toContain('`repo:${githubRepository}:environment:${config.stage}`');
  });
});

describe('every job that signs in to AWS', () => {
  const all = jobs();
  const signing = Object.entries(all).filter(([, text]) => text.includes('aws-actions/configure-aws-credentials'));

  it('is one of the four deploying jobs', () => {
    expect(Object.keys(all)).toEqual(['resolve-env', 'build-image', 'cdk-deploy', 'db-migrate', 'verify-deploy']);
    expect(signing.map(([id]) => id)).toEqual(['build-image', 'cdk-deploy', 'db-migrate', 'verify-deploy']);
  });

  it('declares the environment, so its token’s subject is the one the role trusts', () => {
    for (const [id, text] of signing) {
      expect(text, id).toMatch(/^ {4}environment: \$\{\{ needs\.resolve-env\.outputs\.stage \}\}$/m);
      expect(text, id).toContain('role-to-assume: ${{ env.CD_ROLE_ARN }}');
    }
  });

  it('resolves to dev, the one stage there is', () => {
    expect(all['resolve-env']).toContain('echo "stage=dev"');
    expect(all['resolve-env']).not.toMatch(/stage=prod|inputs\.stage/);
  });

  it('reads no stored AWS key', () => {
    expect(CD).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\./);
  });
});

describe('the workflow_run gate', () => {
  const gate = jobs()['resolve-env'].match(/if: >-\n([\s\S]*?)\n {4}runs-on:/)?.[1] ?? '';

  it('deploys only a successful CI run of a push to this repository', () => {
    // `branches: [main]` matches the head branch by name, so a fork's pull request from a
    // branch called main would pass it; these two conditions are what stop that.
    expect(gate).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(gate).toContain("github.event.workflow_run.event == 'push'");
    expect(gate).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  });

  it('never cancels a deploy in progress', () => {
    expect(CD).toMatch(/^ {2}cancel-in-progress: false$/m);
  });
});

describe('cd.yml names what deploy-dev.sh and the CDK name', () => {
  it('the region, repository, stack and database log group', () => {
    expect(envValue('AWS_REGION')).toBe(scriptValue('REGION'));
    expect(envValue('ECR_REPOSITORY')).toBe(scriptValue('REPOSITORY'));
    expect(envValue('COMPUTE_STACK')).toBe(scriptValue('STACK'));
    expect(envValue('DB_LOG_GROUP')).toBe(scriptValue('DB_LOG_GROUP'));
  });

  it('the host', () => {
    expect(CONFIG).toContain(`domainName: '${envValue('DOMAIN_NAME')}'`);
  });

  it('the Compute stack outputs it reads', () => {
    for (const key of ['ClusterName', 'DbTaskFamily', 'TaskSubnets', 'TaskSecurityGroup']) {
      expect(COMPUTE, key).toContain(`new CfnOutput(this, '${key}'`);
      expect(CD.includes(`output ${key})`) || CD.includes(`OutputKey=='${key}'`), key).toBe(true);
    }
  });

  it('the services it restarts', () => {
    expect(COMPUTE).toContain('serviceName: `${prefix}-web`');
    expect(COMPUTE).toContain('serviceName: `${prefix}-worker`');
    expect(CD).toContain('for svc in web worker; do');
  });

  it('the health route the target group checks', () => {
    expect(COMPUTE).toContain("path: '/api/health'");
    expect(CD).toContain('${TARGET}/api/health');
  });

  it('a 7-character tag, as deploy-dev.sh tags, so both name the same immutable image', () => {
    expect(DEPLOY_DEV).toContain('git rev-parse --short=7');
    expect(CD).toContain('TAG="${SHA::7}"');
  });
});
