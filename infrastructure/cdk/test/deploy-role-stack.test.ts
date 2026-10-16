/**
 * DeployRoleStack — trust-policy assertions.
 *
 * This role holds AdministratorAccess in a stage account, so who may enter it is
 * the whole security boundary of the pipeline. These assertions pin the subject
 * to the stage's GitHub Environment and guard against the two ways the trust
 * silently widens: a wildcard subject, or a stale IAM-user principal left behind
 * after the static-key cutover.
 *
 * VeloExpense: ported from ExpenseOS `infrastructure/cdk/test/deploy-role-stack.test.ts`
 * (1e682dd6). The role does NOT hold AdministratorAccess here (the account is shared by
 * every Velotech product; see the stack's header), so the last block below is
 * VeloExpense's own: it pins what the role may do. Who may enter it is still the
 * boundary that matters most, and those assertions are ExpenseOS's. One stage (dev),
 * and no runner account or legacy IAM user to pass in.
 */
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildConfig, GITHUB_REPOSITORY, type Stage } from '../lib/config';
import { DeployRoleStack } from '../lib/deploy-role-stack';

const CERT = 'arn:aws:acm:ca-central-1:535079144866:certificate/11111111-2222-3333-4444-555555555555';

function synth(stage: Stage): Template {
  const config = buildConfig(stage, { albCertificateArn: CERT });
  const app = new App();
  const stack = new DeployRoleStack(app, 'DeployRole', {
    env: { account: config.accountId, region: config.region },
    config,
    githubRepository: GITHUB_REPOSITORY,
  });
  return Template.fromStack(stack);
}

/** The stack defines exactly one role; read it without pinning its logical ID. */
function trustDocument(template: Template): string {
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  expect(roles).toHaveLength(1);
  return JSON.stringify(roles[0].Properties?.AssumeRolePolicyDocument);
}

/** VeloExpense: every statement the role is granted, inline or managed. */
function grants(template: Template): Array<{ Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  return policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
}

const STAGES: Stage[] = ['dev'];

describe.each(STAGES)('DeployRoleStack (%s)', (stage) => {
  it('creates no OIDC provider — Terraform owns it', () => {
    // VeloExpense: not Terraform here. The provider already exists in the shared
    // account (VeloCRM's and VeloLedger's CD roles use it). Creating it here too would
    // fail with EntityAlreadyExists and roll back the stack, taking the whole
    // `cdk deploy --all` with it.
    synth(stage).resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  it('federates to this account’s provider by its deterministic ARN', () => {
    // formatArn renders the partition as an Fn::Join over AWS::Partition, so the
    // literal arn: prefix is not in the document — assert the account-and-resource
    // half, which is what pins it to this account's provider.
    expect(trustDocument(synth(stage))).toContain(
      ':iam::535079144866:oidc-provider/token.actions.githubusercontent.com',
    );
  });

  it('trusts GitHub only on this stage’s environment subject', () => {
    synth(stage).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:velotechsystems/product-veloexpense:environment:${stage}`,
              },
            },
          }),
        ]),
      },
    });
  });

  it('pins the subject with no wildcard, so no other ref or environment matches', () => {
    const doc = trustDocument(synth(stage));
    // A StringLike subject, or any `*` inside one, would let a different branch
    // or environment into an AdministratorAccess role.
    expect(doc).not.toContain('StringLike');
    expect(doc).not.toContain(`repo:velotechsystems/product-veloexpense:environment:${stage}*`);
  });

  it('outlives the static keys: no IAM-user principal once the cutover completes', () => {
    // VeloExpense: never had static keys; this also rules out an account or role
    // principal, since GitHub's federation is the only way in.
    const doc = trustDocument(synth(stage));
    expect(doc).not.toContain(':user/');
    expect(doc).not.toContain(':root');
    expect(doc).not.toContain('"AWS"');
  });

  it('allows a session long enough for the 60-minute cdk-deploy job', () => {
    synth(stage).hasResourceProperties('AWS::IAM::Role', { MaxSessionDuration: 7200 });
  });

  // ── VeloExpense: what the role may do ──────────────────────────────────────

  it('is named per stage, since every stage shares the account', () => {
    synth(stage).hasResourceProperties('AWS::IAM::Role', { RoleName: `veloexpense-${stage}-deploy-role` });
  });

  it('holds no managed policy, AdministratorAccess least of all', () => {
    const doc = JSON.stringify(synth(stage).toJSON());
    expect(doc).not.toContain('ManagedPolicyArns');
    expect(doc).not.toContain('AdministratorAccess');
  });

  it('never grants every action, or a whole service', () => {
    for (const s of grants(synth(stage))) {
      for (const action of [s.Action].flat()) {
        expect(action, `${s.Sid} grants ${action}`).not.toMatch(/(^\*$|:\*$)/);
      }
    }
  });

  it('touches every resource only for the ECR login token, which takes none', () => {
    const unscoped = grants(synth(stage)).filter((s) => JSON.stringify(s.Resource) === '"*"');
    expect(unscoped.map((s) => s.Action)).toEqual(['ecr:GetAuthorizationToken']);
  });

  it('takes on only CDK’s default bootstrap roles in this account and region', () => {
    const [assume] = grants(synth(stage)).filter((s) => [s.Action].flat().includes('sts:AssumeRole'));
    const resources = JSON.stringify(assume.Resource);
    for (const r of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
      expect(resources).toContain(`:iam::535079144866:role/cdk-hnb659fds-${r}-role-535079144866-ca-central-1`);
    }
    expect(resources).not.toMatch(/role\/\*|cdk-\*/);
  });

  it('pushes to this stage’s repository, starts this stage’s database task, and passes only its own roles to ECS', () => {
    const doc = JSON.stringify(grants(synth(stage)));
    expect(doc).toContain(`repository/veloexpense-${stage}/web`);
    expect(doc).toContain(`task-definition/veloexpense-${stage}-db:*`);
    expect(doc).toContain(`service/*/veloexpense-${stage}-worker`);
    expect(doc).toContain(`log-group:/ecs/veloexpense-${stage}/*`);
    const [pass] = grants(synth(stage)).filter((s) => s.Action === 'iam:PassRole');
    expect(JSON.stringify(pass.Resource)).toContain(`role/veloexpense-${stage}-*`);
    expect(pass.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
  });
});
