/**
 * What the synthesised templates must and must not contain.
 *
 * Every case here is a way this infrastructure could be wrong while still
 * synthesising and deploying cleanly — the class of failure that only shows up
 * as somebody else's outage or a credential in the wrong container.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../lib/config';
import { ComputeStack } from '../lib/compute-stack';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { StorageStack } from '../lib/storage-stack';

const CERT = 'arn:aws:acm:ca-central-1:535079144866:certificate/11111111-2222-3333-4444-555555555555';

function synth() {
  const app = new App();
  const config = buildConfig('dev', { albCertificateArn: CERT });
  const env = { account: config.accountId, region: config.region };
  const security = new SecurityStack(app, 'Sec', { env, config });
  const network = new NetworkStack(app, 'Net', { env, config });
  const storage = new StorageStack(app, 'Sto', { env, config, masterKeyArn: security.masterKey.keyArn });
  const data = new DataStack(app, 'Dat', {
    env,
    config,
    databaseSecurityGroupId: network.databaseSecurityGroup.securityGroupId,
    masterKeyArn: security.masterKey.keyArn,
  });
  const compute = new ComputeStack(app, 'Cmp', {
    env,
    config,
    imageTag: 'abc123',
    serviceSecurityGroupId: network.serviceSecurityGroup.securityGroupId,
    masterKeyArn: security.masterKey.keyArn,
    dbHost: data.cluster.clusterEndpoint.hostname,
    authSecretArn: security.authSecret.secretArn,
    workerSecretArn: security.workerSecret.secretArn,
    appDbSecretArn: security.appDbSecret.secretArn,
    masterDbSecretArn: data.cluster.secret!.secretArn,
  });
  const t = (s: SecurityStack | NetworkStack | StorageStack | DataStack | ComputeStack) => Template.fromStack(s);
  return {
    config,
    security: t(security),
    network: t(network),
    storage: t(storage),
    data: t(data),
    compute: t(compute),
    all: [security, network, storage, data, compute].map(t),
  };
}

const s = synth();

/** The CloudFormation parameter a stack uses for a shared SSM key, e.g. 'alb-sg-id'. */
function sharedParam(tpl: Template, key: string): string | undefined {
  const params = tpl.toJSON().Parameters ?? {};
  return Object.entries(params).find(
    ([, v]) => (v as { Default?: string }).Default === `/velotech/dev/shared/${key}`,
  )?.[0];
}

function resources(tpl: Template, type: string): Array<[string, { Properties: Record<string, unknown> }]> {
  return Object.entries(tpl.toJSON().Resources ?? {}).filter(
    ([, r]) => (r as { Type: string }).Type === type,
  ) as Array<[string, { Properties: Record<string, unknown> }]>;
}

const json = (v: unknown) => JSON.stringify(v);

describe('the shared infrastructure is read, never changed', () => {
  it('no stack adds a rule to the shared ALB security group', () => {
    for (const tpl of s.all) {
      const albSg = sharedParam(tpl, 'alb-sg-id');
      if (!albSg) continue;
      for (const type of ['AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress']) {
        for (const [id, r] of resources(tpl, type)) {
          expect(json(r.Properties.GroupId), `${id} writes a rule onto the shared ALB group`).not.toContain(albSg);
        }
      }
    }
  });

  it('no stack imports a product-velocrm CloudFormation export (SSM only)', () => {
    for (const tpl of s.all) {
      expect(json(tpl.toJSON())).not.toMatch(/"Fn::ImportValue":"Velotech-|"Fn::ImportValue":"VeloCrm-/);
    }
  });

  it('the web service joins the shared apps group, and our own', () => {
    const [[, svc]] = resources(s.compute, 'AWS::ECS::Service');
    const groups = json((svc.Properties.NetworkConfiguration as { AwsvpcConfiguration: unknown }).AwsvpcConfiguration);
    expect(groups).toContain(sharedParam(s.compute, 'apps-sg-id'));
    expect(groups).toContain('ServiceSg');
  });
});

describe('the shared listener', () => {
  it('routes OUR host only, at a priority inside VeloExpense’s band', () => {
    const [[, rule]] = resources(s.compute, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    const p = rule.Properties as { Priority: number; Conditions: unknown; ListenerArn: unknown };
    expect(p.Priority).toBeGreaterThanOrEqual(100);
    expect(p.Priority).toBeLessThanOrEqual(199);
    expect(json(p.Conditions)).toBe(json([{ Field: 'host-header', HostHeaderConfig: { Values: ['dev.veloexpense.ai'] } }]));
    expect(json(p.ListenerArn)).toContain(sharedParam(s.compute, 'https-listener-arn'));
  });

  it('the service is created after its rule, or ECS refuses an unattached target group', () => {
    const [[, svc]] = resources(s.compute, 'AWS::ECS::Service');
    const [[ruleId]] = resources(s.compute, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    expect((svc as unknown as { DependsOn?: string[] }).DependsOn).toContain(ruleId);
  });

  it('adds our certificate to that listener by SNI', () => {
    s.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', {
      Certificates: [{ CertificateArn: CERT }],
    });
  });

  it('the target group checks the route the proxy lets through unauthenticated', () => {
    s.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/api/health',
      Port: 3000,
      TargetType: 'ip',
    });
  });
});

describe('credentials go only where they are needed', () => {
  const taskDefs = () =>
    resources(s.compute, 'AWS::ECS::TaskDefinition').map(([, r]) => {
      const p = r.Properties as { Family: string; ContainerDefinitions: Array<{ Secrets?: Array<{ Name: string; ValueFrom: unknown }> }> };
      return { family: p.Family, secrets: p.ContainerDefinitions.flatMap((c) => c.Secrets ?? []) };
    });

  it('the web task never receives the master login', () => {
    const web = taskDefs().find((t) => t.family === 'veloexpense-dev-web')!;
    expect(web.secrets.map((x) => x.Name)).not.toContain('DB_ADMIN_PASSWORD');
    expect(json(web.secrets)).not.toContain('rds-master');
    expect(json(web.secrets)).not.toMatch(/DbClusterSecret|MasterDb/);
    expect(web.secrets.map((x) => x.Name)).toEqual(
      expect.arrayContaining(['DB_USER', 'DB_PASSWORD', 'AUTH_SECRET', 'WORKER_SECRET', 'SECRET_ENCRYPTION_KEY']),
    );
  });

  it('only the database task does', () => {
    const holders = taskDefs().filter((t) => t.secrets.some((x) => x.Name === 'DB_ADMIN_PASSWORD'));
    expect(holders.map((t) => t.family)).toEqual(['veloexpense-dev-db']);
  });

  it('a scheduled job receives WORKER_SECRET and nothing else', () => {
    const ticks = taskDefs().filter((t) => t.family.startsWith('veloexpense-dev-tick-'));
    expect(ticks.length).toBe(s.config.schedules.length);
    for (const t of ticks) expect(t.secrets.map((x) => x.Name)).toEqual(['WORKER_SECRET']);
  });

  it('the web execution role cannot read the master secret', () => {
    const policies = resources(s.compute, 'AWS::IAM::Policy').filter(([id]) => id.startsWith('WebExecutionRole'));
    expect(policies.length).toBeGreaterThan(0);
    for (const [, p] of policies) expect(json(p.Properties)).not.toMatch(/MasterDb|DbClusterSecret|rds-master/);
  });
});

describe('the database', () => {
  it('accepts 5432 from the VeloExpense service group only', () => {
    const rules = resources(s.network, 'AWS::EC2::SecurityGroupIngress');
    expect(rules).toHaveLength(1);
    const [[, r]] = rules;
    expect(r.Properties.FromPort).toBe(5432);
    expect(json(r.Properties.SourceSecurityGroupId)).toContain('ServiceSg');
  });

  it('lives in the isolated subnets', () => {
    const [[, g]] = resources(s.data, 'AWS::RDS::DBSubnetGroup');
    const ids = json(g.Properties.SubnetIds);
    expect(ids).toContain(sharedParam(s.data, 'isolated-subnet-1'));
    expect(ids).toContain(sharedParam(s.data, 'isolated-subnet-2'));
    expect(ids).not.toContain('private-subnet');
  });

  it('is encrypted, logs no bind parameters, and runs the major version CI tests', () => {
    s.data.hasResourceProperties('AWS::RDS::DBCluster', { StorageEncrypted: true, Engine: 'aurora-postgresql' });
    const [[, c]] = resources(s.data, 'AWS::RDS::DBCluster');
    expect(String(c.Properties.EngineVersion)).toMatch(/^16\./);
    s.data.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: { log_parameter_max_length: '0', log_parameter_max_length_on_error: '0', 'pgaudit.log_parameter': '0' },
    });
  });

  it('generates alphanumeric passwords, which the entrypoint puts in a URL unescaped', () => {
    const [[, master]] = resources(s.data, 'AWS::SecretsManager::Secret');
    const excluded = (master.Properties.GenerateSecretString as { ExcludeCharacters: string }).ExcludeCharacters;
    for (const ch of ['@', ':', '/', '?', '#', '%', '&']) expect(excluded).toContain(ch);
    const app = resources(s.security, 'AWS::SecretsManager::Secret').find(([id]) => id.startsWith('AppDbSecret'))!;
    expect((app[1].Properties.GenerateSecretString as { ExcludePunctuation: boolean }).ExcludePunctuation).toBe(true);
  });
});

describe('storage', () => {
  it('lets the browser upload from this host and no other', () => {
    const cors = resources(s.storage, 'AWS::S3::Bucket')
      .map(([, b]) => b.Properties.CorsConfiguration as { CorsRules: Array<{ AllowedOrigins: string[] }> } | undefined)
      .filter(Boolean);
    expect(cors).toHaveLength(1); // the receipts bucket; the log bucket has none
    expect(cors[0]!.CorsRules.map((r) => r.AllowedOrigins)).toEqual([['https://dev.veloexpense.ai']]);
  });
});

describe('config', () => {
  it('dev carries its committed, issued certificate; the environment can override it', () => {
    expect(buildConfig('dev').albCertificateArn).toBe(
      'arn:aws:acm:ca-central-1:535079144866:certificate/b9d463c0-8c2f-4754-bf39-cd4231b92a9c',
    );
    expect(buildConfig('dev', { albCertificateArn: CERT }).albCertificateArn).toBe(CERT);
  });
});
