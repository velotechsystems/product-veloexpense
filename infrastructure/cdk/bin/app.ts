#!/usr/bin/env node
/**
 * VeloExpense – CDK application entry point.
 *
 *   Security → Network → Storage → Data → Compute
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
import { buildConfig, type Stage } from '../lib/config';
import { ComputeStack } from '../lib/compute-stack';
import { DataStack } from '../lib/data-stack';
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
  description: 'VeloExpense - web service on the shared cluster/ALB, database task, schedules',
});

compute.addStackDependency(storage); // the image must have a repository before a service can pull it

for (const [k, v] of Object.entries(config.tags)) cdk.Tags.of(app).add(k, v);
