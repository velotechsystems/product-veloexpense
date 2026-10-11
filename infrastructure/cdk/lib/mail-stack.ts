/**
 * MailStack – receipts by email (w3-06): SES receives, S3 holds, SNS tells the app.
 *
 *   mail → MX *.{domain} → SES (ca-central-1) → S3 `{prefix}-inbound-mail-{account}/inbound/…`
 *        → SNS `{prefix}-inbound-mail` → POST {webhookUrl} → enqueue `email.ingestReceipts`
 *
 * VeloExpense's own stack. ExpenseOS's SES stack is not in the source this port works from
 * (its compute stack and config are, and they shape this one): the topic name, the S3-with-
 * pointer action for receipts, the worker-only read grant and the retention are ExpenseOS's;
 * the rest is VeloExpense's.
 *
 * VeloExpense (d47): every tenant has its own address, `receipts@<tenant>.{domain}`, so the
 * rule matches every subdomain of `domain` (SES's leading-dot recipient) and the app reads
 * the tenant from the label. ExpenseOS receives on one domain behind a Workspace forward.
 *
 *   · The bucket is SSE-S3, not the master key. SES writes it, and SES writing under a
 *     customer key needs a key policy for the service; nothing here gains from that, and
 *     a message only lives `retentionDays` before it expires.
 *   · The rule scans (spam and virus verdicts — the app refuses a message without both),
 *     and requires TLS from the sending server.
 *   · Activating the rule set is a switch (`activateRuleSet`): SES allows ONE active rule
 *     set per account and region, and this account is shared by every Velotech product.
 *     When it is on, deleting the stack re-activates `restoreRuleSetNameOnDelete`, or
 *     clears the active set if none is named.
 *
 * DNS is not here: Cloudflare holds veloexpense.ai. The stack outputs the three DKIM CNAMEs
 * that verify `domain`, and the MX to add by hand (`*.{domain}` → the regional endpoint).
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_iam as iam,
  aws_s3 as s3,
  aws_ses as ses,
  aws_ses_actions as sesActions,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  custom_resources as cr,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';

export interface MailStackProps extends StackProps {
  config: VeloExpenseConfig;
}

/** The S3 key prefix SES writes under; the worker reads nothing else. */
export const INBOUND_OBJECT_PREFIX = 'inbound/';

/** The names the compute stack reads by convention, so neither stack references the other. */
export const inboundMailBucketName = (config: VeloExpenseConfig) =>
  `${config.resourcePrefix}-inbound-mail-${config.accountId}`;
export const inboundMailTopicName = (config: VeloExpenseConfig) => `${config.resourcePrefix}-inbound-mail`;

export class MailStack extends Stack {
  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, props);
    const { config } = props;
    const inbound = config.inboundEmail;
    if (!inbound) throw new Error('MailStack needs config.inboundEmail');

    // Easy DKIM on the inbound domain: three CNAMEs verify it, which SES requires before it
    // will accept mail for it.
    const identity = new ses.EmailIdentity(this, 'InboundIdentity', {
      identity: ses.Identity.domain(inbound.domain),
    });

    const bucket = new s3.Bucket(this, 'InboundMailBucket', {
      bucketName: inboundMailBucketName(config),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // A raw message is needed only until the worker has read it; the slack is for a
      // re-run by hand (ExpenseOS's 14-day default).
      lifecycleRules: [{ id: 'expire-inbound', expiration: Duration.days(inbound.retentionDays) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const topic = new sns.Topic(this, 'InboundMailTopic', {
      topicName: inboundMailTopicName(config),
      displayName: 'VeloExpense inbound mail',
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    // The route confirms the subscription itself, for this topic only (INBOUND_SNS_TOPIC_ARN).
    topic.addSubscription(new subs.UrlSubscription(inbound.webhookUrl, { protocol: sns.SubscriptionProtocol.HTTPS }));

    const ruleSet = new ses.ReceiptRuleSet(this, 'InboundRuleSet', {
      receiptRuleSetName: `${config.resourcePrefix}-inbound`,
    });
    const rule = ruleSet.addRule('Receipts', {
      receiptRuleName: 'receipts',
      // Every tenant's subdomain (d47), and not the bare domain, which names no tenant.
      recipients: [`.${inbound.domain}`],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new sesActions.S3({ bucket, objectKeyPrefix: INBOUND_OBJECT_PREFIX, topic }),
        new sesActions.Stop(),
      ],
    });
    rule.node.addDependency(identity);

    if (inbound.activateRuleSet) {
      const restore = inbound.restoreRuleSetNameOnDelete;
      const activate = new cr.AwsCustomResource(this, 'ActivateRuleSet', {
        onCreate: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          parameters: { RuleSetName: ruleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`${config.resourcePrefix}-active-rule-set`),
        },
        onUpdate: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          parameters: { RuleSetName: ruleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`${config.resourcePrefix}-active-rule-set`),
        },
        onDelete: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          // Omitting the name deactivates every set.
          parameters: restore ? { RuleSetName: restore } : {},
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ['ses:SetActiveReceiptRuleSet'], resources: ['*'] }),
        ]),
        installLatestAwsSdk: false,
      });
      activate.node.addDependency(rule);
    }

    new CfnOutput(this, 'InboundMx', {
      description: `Cloudflare: MX *.${inbound.domain}, priority 10, DNS only`,
      value: `inbound-smtp.${this.region}.amazonaws.com`,
    });
    identity.dkimRecords.forEach((r, i) => {
      new CfnOutput(this, `DkimCname${i + 1}`, {
        description: `Cloudflare: CNAME (DNS only) ${i + 1} of 3 verifying ${inbound.domain}`,
        value: `${r.name} -> ${r.value}`,
      });
    });
    new CfnOutput(this, 'InboundBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'InboundTopicArn', { value: topic.topicArn });
  }
}
