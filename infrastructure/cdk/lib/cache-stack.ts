/**
 * CacheStack – ElastiCache Valkey for BullMQ (w3-00, d41).
 *
 * Ported from ExpenseOS `elasticache-stack.ts` (550b2945). Kept as-is, with the reasons
 * it gives:
 *   · A node-based REPLICATION GROUP, single node in dev (numReplicas 0), failover
 *     only when a replica exists.
 *   · A `noeviction` parameter group: BullMQ's keys must never be evicted under memory
 *     pressure, or jobs vanish without failing.
 *   · Encryption at rest with our master key, TLS in transit, and an AUTH token
 *     generated alphanumeric so it sits in a URL unescaped.
 *   · The `redis-url` secret composed HERE, in the stack that owns its inputs, with the
 *     token as a Secrets Manager dynamic reference resolved by CloudFormation — no
 *     plaintext in the template. Compute imports it by name. `rediss://`, because
 *     transit encryption is on.
 *
 * Changed, and why:
 *   · Subnets: the shared VPC's ISOLATED subnets (lib/shared.ts), as Aurora uses,
 *     instead of ExpenseOS's tag-selected `elasticache` subnets — the VPC is
 *     product-velocrm's, and it publishes no such tier.
 *   · The security group and the key are imported by id/ARN, as DataStack imports
 *     them, so nothing writes a rule or a key policy back onto another stack.
 *   · Serves BullMQ only. ExpenseOS's says "BullMQ + cache + sessions"; VeloExpense keeps
 *     sessions in Auth.js's signed cookie and has no data cache.
 *   · Resource names start `veloexpense-<stage>`, and the suite's tags go on through
 *     `Tags.of` like every other VeloExpense stack, in place of ExpenseOS's inline
 *     Project/Stage pair.
 */
import {
  Stack,
  type StackProps,
  SecretValue,
  Tags,
  aws_ec2 as ec2,
  aws_elasticache as elasticache,
  aws_kms as kms,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';
import { importShared } from './shared';

/** Secret names under `secretPrefix`. Compute imports `redis-url` by this name. */
export const REDIS_URL_SECRET = 'redis-url';
export const VALKEY_AUTH_TOKEN_SECRET = 'valkey-auth-token';

export interface CacheStackProps extends StackProps {
  config: VeloExpenseConfig;
  cacheSecurityGroupId: string;
  masterKeyArn: string;
}

export class CacheStack extends Stack {
  /** Valkey replication group */
  public readonly replicationGroup: elasticache.CfnReplicationGroup;

  /** Valkey primary endpoint */
  public readonly endpoint: string;

  /** Valkey AUTH token secret */
  public readonly authToken: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = config.resourcePrefix;
    const { vpc } = importShared(this, config.sharedStage);
    const masterKey = kms.Key.fromKeyArn(this, 'MasterKey', props.masterKeyArn);
    const cacheSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'CacheSg', props.cacheSecurityGroupId, {
      mutable: false,
    });

    // -- 1. AUTH Token --------------------------------------------------------

    this.authToken = new secretsmanager.Secret(this, 'AuthToken', {
      secretName: `${config.secretPrefix}/${VALKEY_AUTH_TOKEN_SECRET}`,
      description: 'ElastiCache Valkey AUTH token',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      encryptionKey: masterKey,
    });

    // -- 2. Subnet Group ------------------------------------------------------

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'VeloExpense Valkey subnet group',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${prefix}-valkey`,
    });

    // -- 3. Parameter Group (noeviction required by BullMQ) ---------------------

    const parameterGroup = new elasticache.CfnParameterGroup(this, 'ParameterGroup', {
      cacheParameterGroupFamily: 'valkey8',
      description: 'VeloExpense Valkey - noeviction for BullMQ',
      properties: {
        'maxmemory-policy': 'noeviction',
      },
    });

    // -- 4. Replication Group -------------------------------------------------

    this.replicationGroup = new elasticache.CfnReplicationGroup(this, 'Cluster', {
      replicationGroupId: prefix,
      replicationGroupDescription: 'VeloExpense Valkey - BullMQ',
      engine: 'valkey',
      engineVersion: config.valkey.engineVersion,
      cacheNodeType: config.valkey.nodeType,
      numCacheClusters: 1 + config.valkey.numReplicas,
      automaticFailoverEnabled: config.valkey.numReplicas > 0,
      multiAzEnabled: config.valkey.numReplicas > 0,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
      securityGroupIds: [cacheSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      kmsKeyId: masterKey.keyId,
      snapshotRetentionLimit: config.valkey.snapshotRetentionDays,
      snapshotWindow: '04:00-05:00',
      preferredMaintenanceWindow: 'sun:06:00-sun:07:00',
      authToken: this.authToken.secretValue.unsafeUnwrap(),
      cacheParameterGroupName: parameterGroup.ref,
      port: 6379,
    });
    // VeloExpense: `addResourceDependency`, the name this aws-cdk-lib gives ExpenseOS's
    // (now deprecated) `addDependency`.
    this.replicationGroup.addResourceDependency(subnetGroup);

    this.endpoint = this.replicationGroup.attrPrimaryEndPointAddress;

    // -- 5. redis-url secret (composed here, the stack that owns the inputs) ---
    // Compute imports this by name (no cross-stack value coupling). transit
    // encryption is on, so clients connect over TLS → "rediss://". The AUTH
    // token excludes punctuation, so it is URL-safe (no encoding needed). The
    // token is embedded as a Secrets Manager dynamic reference, resolved by
    // CloudFormation at create time — no plaintext transits the template.
    new secretsmanager.Secret(this, 'RedisUrl', {
      secretName: `${config.secretPrefix}/${REDIS_URL_SECRET}`,
      description: 'Full Valkey (Redis-compatible) connection URL for the app + BullMQ',
      encryptionKey: masterKey,
      secretStringValue: SecretValue.unsafePlainText(
        `rediss://:${this.authToken.secretValue.unsafeUnwrap()}@${this.endpoint}:6379`,
      ),
    });

    // -- 6. Tags --------------------------------------------------------------
    for (const [key, value] of Object.entries(config.tags)) {
      Tags.of(this).add(key, value);
    }
  }
}
