/**
 * NetworkStack – VeloExpense's OWN security groups, inside the shared VPC.
 *
 * ExpenseOS's network stack imports a VPC and creates every group; here the VPC
 * is product-velocrm's and so is the ALB's group, so only ours remain:
 *
 *   service   The Fargate web task. Egress anywhere (Google sign-in, SMTP, S3,
 *             the ledger). Ingress: none of its own — the ALB reaches the task
 *             because the task ALSO joins the shared apps group, whose ingress
 *             rule product-velocrm owns. The scheduled jobs use this group too.
 *   database  Aurora. Ingress on 5432 from `service` ONLY. Not from the shared
 *             apps group: that group will hold every other Velotech product's
 *             tasks, and none of them has business on this port.
 *   cache     Valkey (w3-00). Ingress on 6379 from `service` ONLY, for the same
 *             reason. The worker joins `service`: it needs the database, the cache
 *             and the internet (the model API, S3), exactly what the web task needs.
 */
import { Stack, type StackProps, Tags, aws_ec2 as ec2 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';
import { importShared } from './shared';

export interface NetworkStackProps extends StackProps {
  config: VeloExpenseConfig;
}

export class NetworkStack extends Stack {
  public readonly serviceSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly cacheSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;
    const vpc = importShared(this, config.sharedStage).vpcForSecurityGroups;
    const prefix = config.resourcePrefix;

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      securityGroupName: `${prefix}-service-sg`,
      description: 'VeloExpense web task and scheduled jobs',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      securityGroupName: `${prefix}-db-sg`,
      description: 'VeloExpense Aurora - 5432 from the VeloExpense service group only',
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from VeloExpense tasks',
    );

    this.cacheSecurityGroup = new ec2.SecurityGroup(this, 'CacheSg', {
      vpc,
      securityGroupName: `${prefix}-cache-sg`,
      description: 'VeloExpense Valkey - 6379 from the VeloExpense service group only',
      allowAllOutbound: false,
    });
    this.cacheSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(6379),
      'Valkey from VeloExpense tasks',
    );

    for (const [key, value] of Object.entries(config.tags)) Tags.of(this).add(key, value);
  }
}
