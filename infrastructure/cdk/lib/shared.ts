/**
 * The shared Velotech infrastructure, as product-velocrm publishes it.
 *
 * That repo's `lib/shared-contract.ts` is the other half of this file. It
 * publishes SSM parameters under `/velotech/<stage>/shared/<key>`; we read them
 * at DEPLOY time (`valueForStringParameter` becomes a CloudFormation parameter),
 * so synth needs no AWS credentials and no context lookups, and a re-pointed
 * parameter is picked up on our next deploy.
 *
 * The rule, from that file: read these, never create or modify what they name.
 * Everything we attach — a listener rule, an SNI certificate, a target group, a
 * service in the cluster, our own security groups — is a resource in OUR stacks
 * that references theirs.
 */
import { aws_ec2 as ec2, aws_ecs as ecs, aws_ssm as ssm } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { SharedStage } from './config';

/** Mirrors product-velocrm `SharedParam`. A key missing there fails our deploy, not silently. */
export type SharedParam =
  | 'vpc-id'
  | 'vpc-cidr'
  | 'az-1'
  | 'az-2'
  | 'private-subnet-1'
  | 'private-subnet-2'
  | 'isolated-subnet-1'
  | 'isolated-subnet-2'
  | 'alb-sg-id'
  | 'apps-sg-id'
  | 'alb-arn'
  | 'alb-dns-name'
  | 'https-listener-arn'
  | 'cluster-name';

/** Mirrors product-velocrm `SHARED_APP_PORT`: the only port the ALB may reach on the apps group. */
export const SHARED_APP_PORT = 3000;

export function sharedParamName(stage: SharedStage, key: SharedParam): string {
  return `/velotech/${stage}/shared/${key}`;
}

export interface SharedInfra {
  vpc: ec2.IVpc;
  /**
   * The VPC by id alone — enough to own a security group in it. For a stack that
   * places nothing in subnets, so it does not take the AZ and subnet parameters.
   */
  vpcForSecurityGroups: ec2.IVpc;
  /** The group the shared ALB may reach on SHARED_APP_PORT. Our service joins it. */
  appsSecurityGroupId: string;
  /** The shared ALB's own group. Import it IMMUTABLE — it is never ours to change. */
  albSecurityGroupId: string;
  httpsListenerArn: string;
  albDnsName: string;
  cluster: ecs.ICluster;
}

/**
 * Import the shared infrastructure into `scope` (a stack of ours).
 *
 * LAZY: each SSM parameter becomes a CloudFormation parameter of the stack that
 * reads it, so a stack only takes the ones it actually uses — a stack carrying
 * parameters it never references is one more thing that can fail its deploy.
 *
 * The VPC is built from attributes rather than looked up: two AZs, matching the
 * two-AZ contract product-velocrm enforces at synth, and no AWS calls at synth.
 * Call once per stack — a construct cannot be shared across stacks without
 * creating a CloudFormation export between them.
 */
export function importShared(scope: Construct, stage: SharedStage): SharedInfra {
  const cache = new Map<SharedParam, string>();
  const p = (key: SharedParam) => {
    let v = cache.get(key);
    if (v === undefined) {
      v = ssm.StringParameter.valueForStringParameter(scope, sharedParamName(stage, key));
      cache.set(key, v);
    }
    return v;
  };

  let vpc: ec2.IVpc | undefined;
  const getVpc = () =>
    (vpc ??= ec2.Vpc.fromVpcAttributes(scope, 'SharedVpc', {
      vpcId: p('vpc-id'),
      availabilityZones: [p('az-1'), p('az-2')],
      privateSubnetIds: [p('private-subnet-1'), p('private-subnet-2')],
      isolatedSubnetIds: [p('isolated-subnet-1'), p('isolated-subnet-2')],
    }));

  let cluster: ecs.ICluster | undefined;
  let idOnly: ec2.IVpc | undefined;

  return {
    get vpc() {
      return getVpc();
    },
    get vpcForSecurityGroups() {
      return (idOnly ??= ec2.Vpc.fromVpcAttributes(scope, 'SharedVpcById', {
        vpcId: p('vpc-id'),
        // fromVpcAttributes insists on at least one AZ. A security group renders
        // only the VPC id, so this value never reaches a template (test/stacks.test.ts).
        availabilityZones: ['unused-by-security-groups'],
      }));
    },
    get appsSecurityGroupId() {
      return p('apps-sg-id');
    },
    get albSecurityGroupId() {
      return p('alb-sg-id');
    },
    get httpsListenerArn() {
      return p('https-listener-arn');
    },
    get albDnsName() {
      return p('alb-dns-name');
    },
    get cluster() {
      return (cluster ??= ecs.Cluster.fromClusterAttributes(scope, 'SharedCluster', {
        clusterName: p('cluster-name'),
        vpc: getVpc(),
        securityGroups: [],
      }));
    },
  };
}
