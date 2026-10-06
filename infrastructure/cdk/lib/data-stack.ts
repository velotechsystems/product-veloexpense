/**
 * DataStack – Aurora PostgreSQL Serverless v2 for VeloExpense.
 *
 * Ported from ExpenseOS `rds-stack.ts`. Kept as-is, with the reasons it gives:
 *   · Serverless v2, scaling between config.rds.minAcu and maxAcu.
 *   · The parameter group, including `log_parameter_max_length = 0`: slow
 *     statements are logged, and Postgres appends their BIND PARAMETERS unless
 *     told not to. VeloExpense binds integration credentials and personal data
 *     the same way ExpenseOS bound card numbers.
 *   · pgaudit for DDL and role changes; pg_stat_statements.
 *   · Storage encrypted with our master key; snapshot on removal.
 *   · Import cross-stack groups and keys by id/ARN, so RDS's mutation of
 *     security-group connections and key policies cannot create back-references.
 *
 * Changed, and why:
 *   · ENGINE 16, not 17. CI and every laptop run postgres:16, and the migrations
 *     (btree_gist exclusion constraints, FORCE RLS) are verified against 16.
 *     Moving the major version is its own change with its own test run.
 *   · NO RDS PROXY in staging. On Aurora Serverless v2 the proxy bills a minimum
 *     of 8 ACUs (about US$85/month), more than this database costs at minimum.
 *     One web task with PG_POOL_MAX connections, plus a scheduled job now and
 *     then, does not need pooling in front of the pool. Production revisits it.
 *   · NO hosted rotation of the master secret in staging. The rotation Lambda
 *     needs its own network path and an excludeCharacters set matching ours; it
 *     is production work. The master login is used only by the one-off database
 *     task (bootstrap + migrations), never by the running app.
 *   · Passwords exclude punctuation, so docker-entrypoint.sh can put them in a
 *     URL without escaping. 40 alphanumeric characters is ~238 bits.
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_ec2 as ec2,
  aws_kms as kms,
  aws_rds as rds,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';
import { importShared } from './shared';

/** Every printable ASCII punctuation character — see "Passwords exclude punctuation". */
export const PUNCTUATION = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** The master login. Used by the database task only. */
export const ADMIN_USERNAME = 'veloexpense_admin';

export interface DataStackProps extends StackProps {
  config: VeloExpenseConfig;
  databaseSecurityGroupId: string;
  masterKeyArn: string;
}

export class DataStack extends Stack {
  public readonly cluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = config.resourcePrefix;
    const { vpc } = importShared(this, config.sharedStage);

    const dbSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'DatabaseSg', props.databaseSecurityGroupId);
    const masterKey = kms.Key.fromKeyArn(this, 'MasterKey', props.masterKeyArn);

    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_13,
    });

    const parameterGroup = new rds.ParameterGroup(this, 'DbParamGroup', {
      engine,
      description: 'VeloExpense PostgreSQL parameter group',
      parameters: {
        log_statement: 'ddl',
        log_min_duration_statement: '1000',
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
        shared_preload_libraries: 'pg_stat_statements,pgaudit',
        'pgaudit.log': 'ddl,role',
        'pgaudit.log_parameter': '0',
        idle_in_transaction_session_timeout: '300000',
      },
    });

    this.cluster = new rds.DatabaseCluster(this, 'DbCluster', {
      clusterIdentifier: prefix,
      engine,
      credentials: rds.Credentials.fromGeneratedSecret(ADMIN_USERNAME, {
        secretName: `${config.secretPrefix}/rds-master`,
        encryptionKey: masterKey,
        excludeCharacters: PUNCTUATION,
      }),
      defaultDatabaseName: config.rds.databaseName,
      parameterGroup,
      serverlessV2MinCapacity: config.rds.minAcu,
      serverlessV2MaxCapacity: config.rds.maxAcu,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      }),
      readers: [],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      storageEncrypted: true,
      storageEncryptionKey: masterKey,
      backup: {
        retention: Duration.days(config.rds.backupRetentionDays),
        preferredWindow: '07:00-08:00', // 03:00-04:00 Toronto
      },
      preferredMaintenanceWindow: 'sun:09:00-sun:10:00',
      deletionProtection: config.rds.deletionProtection,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
    });

    for (const [key, value] of Object.entries(config.tags)) Tags.of(this).add(key, value);
  }
}
