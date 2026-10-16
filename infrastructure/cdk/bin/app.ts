#!/usr/bin/env node
/**
 * VeloExpense – CDK application entry point.
 *
 *   DeployRole (independent), then
 *   Security → Network → Storage → Data → Cache → Compute, and Mail where receipts by
 *   email is configured (w3-06) — on its own: Compute names its topic and bucket rather than
 *   referencing them, so the two deploy independently.
 *
 * Everything here deploys INTO the shared velotech-<sharedStage> infrastructure
 * that product-velocrm's CDK owns (see lib/shared.ts). None of these stacks
 * depends on a product-velocrm stack in CloudFormation terms — they read SSM
 * parameters at deploy time — so `cdk deploy` here can never redeploy theirs.
 *
 * Usage (from this directory):
 *   VELOEXPENSE_STAGE=dev IMAGE_TAG=<tag> npx cdk deploy --all
 *
 * IMAGE_TAG is required for Compute, and deliberately has no default: "latest"
 * on an immutable-tag repository would name whichever build happened to be
 * pushed last, which is not a deploy anybody chose.
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CacheStack } from '../lib/cache-stack';
import { buildConfig, GITHUB_REPOSITORY, type Stage } from '../lib/config';
import { ComputeStack } from '../lib/compute-stack';
import { DataStack } from '../lib/data-stack';
import { DeployRoleStack } from '../lib/deploy-role-stack';
import { MailStack } from '../lib/mail-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { StorageStack } from '../lib/storage-stack';

const app = new cdk.App();
const stage = (app.node.tryGetContext('stage') ?? process.env.VELOEXPENSE_STAGE ?? 'dev') as Stage;

const config = buildConfig(stage, { albCertificateArn: process.env.ALB_CERTIFICATE_ARN });

const imageTag = app.node.tryGetContext('imageTag') ?? process.env.IMAGE_TAG;
if (!imageTag) {
  throw new Error('IMAGE_TAG is required (the tag in ECR to run). There is no default; see bin/app.ts.');
}

const env: cdk.Environment = { account: config.accountId, region: config.region };
const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const prefix = `VeloExpense-${pascal(config.stage)}`;

// Ported from ExpenseOS: the role the CD workflow assumes through GitHub OIDC. It
// depends on nothing, and nothing depends on it; deployed once by hand first (see its header).
new DeployRoleStack(app, `${prefix}-DeployRole`, {
  env,
  config,
  githubRepository: GITHUB_REPOSITORY,
  description: 'VeloExpense - IAM role GitHub Actions assume to deploy (OIDC)',
});

const security = new SecurityStack(app, `${prefix}-Security`, {
  env,
  config,
  description: 'VeloExpense - KMS key and secrets',
});

const network = new NetworkStack(app, `${prefix}-Network`, {
  env,
  config,
  description: 'VeloExpense - own security groups in the shared Velotech VPC',
});

const storage = new StorageStack(app, `${prefix}-Storage`, {
  env,
  config,
  masterKeyArn: security.masterKey.keyArn,
  description: 'VeloExpense - receipts bucket and ECR repository',
});

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  config,
  databaseSecurityGroupId: network.databaseSecurityGroup.securityGroupId,
  masterKeyArn: security.masterKey.keyArn,
  description: 'VeloExpense - Aurora PostgreSQL Serverless v2',
});

const cache = new CacheStack(app, `${prefix}-Cache`, {
  env,
  config,
  cacheSecurityGroupId: network.cacheSecurityGroup.securityGroupId,
  masterKeyArn: security.masterKey.keyArn,
  description: 'VeloExpense - ElastiCache Valkey for the BullMQ worker',
});

const compute = new ComputeStack(app, `${prefix}-Compute`, {
  env,
  config,
  imageTag,
  serviceSecurityGroupId: network.serviceSecurityGroup.securityGroupId,
  masterKeyArn: security.masterKey.keyArn,
  dbHost: data.cluster.clusterEndpoint.hostname,
  authSecretArn: security.authSecret.secretArn,
  workerSecretArn: security.workerSecret.secretArn,
  appDbSecretArn: security.appDbSecret.secretArn,
  // biome-ignore lint: the generated secret always exists on a cluster created with fromGeneratedSecret.
  masterDbSecretArn: data.cluster.secret!.secretArn,
  description: 'VeloExpense - web and worker services on the shared cluster/ALB, database task, schedules',
});

compute.addStackDependency(storage); // the image must have a repository before a service can pull it
// Compute reads the redis-url secret BY NAME, so CloudFormation sees no reference to the
// cache stack; a task started before that secret exists fails to start.
compute.addStackDependency(cache);

if (config.inboundEmail) {
  new MailStack(app, `${prefix}-Mail`, {
    env,
    config,
    description: 'VeloExpense - receipts by email: SES receiving, the inbound-mail bucket and topic',
  });
}

for (const [k, v] of Object.entries(config.tags)) cdk.Tags.of(app).add(k, v);
