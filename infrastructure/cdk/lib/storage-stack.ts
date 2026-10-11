/**
 * StorageStack – the receipts bucket, its access-log bucket, and the ECR repo.
 *
 * Ported from ExpenseOS `storage-stack.ts` and `registry-stack.ts`.
 *
 * Kept: KMS encryption with our master key and an S3 bucket key; versioning;
 * public access blocked; TLS enforced; server access logs; CORS for the browser's
 * presigned PUT and GET from this environment's host ONLY; abort incomplete
 * multipart uploads after 7 days. ECR: immutable tags (a tag names exactly one
 * build, so a rollback is a redeploy of a known image), scan on push, keep 20.
 *
 * Dropped, and why:
 *   · exports and audit buckets — VeloExpense has one storage contract,
 *     STORAGE_BUCKET; exports are generated on request and the audit trail is in
 *     Postgres.
 *   · the inbound-mail bucket — it arrived with receipts by email (w3-06) in the Mail
 *     stack (mail-stack.ts), beside the SES rule that writes it.
 *   · (Since restored) GuardDuty Malware Protection — dropped while nothing read the
 *     verdict; ported back with receipt extraction (w3-02a, d42), below.
 *   · intelligent tiering — receipts here are small and recent; revisit at volume.
 *   · the worker repository — the worker runs this image with another command
 *     (compute-stack.ts, w3-00).
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_ecr as ecr,
  aws_guardduty as guardduty,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';

export interface StorageStackProps extends StackProps {
  config: VeloExpenseConfig;
  masterKeyArn: string;
}

export class StorageStack extends Stack {
  public readonly receiptsBucket: s3.Bucket;
  public readonly webRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = config.resourcePrefix;
    const masterKey = kms.Key.fromKeyArn(this, 'MasterKey', props.masterKeyArn);

    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `${prefix}-access-logs-${config.accountId}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'expire-logs', expiration: Duration.days(90) }],
    });

    this.receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      bucketName: `${prefix}-receipts-${config.accountId}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: masterKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'receipts/',
      // Receipts are financial records people were told we keep. Even in a test environment
      // a stack deletion must not take them with it silently.
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: [`https://${config.domainName}`],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [{ id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });

    // -- GuardDuty Malware Protection for S3 (receipts) — w3-02a, d42 -------------
    // Ported from ExpenseOS's storage-stack.ts (550b2945), verbatim but for the role name's
    // prefix. Managed, out-of-band AV: GuardDuty scans every new object on the receipts
    // bucket and writes a `GuardDutyMalwareScanStatus` object tag. The worker's
    // extraction handler reads that tag before extracting (see lib/storage +
    // worker/src/handlers/lib/extract-core.ts), so no ClamAV runs in the container.
    //
    // The role GuardDuty assumes to scan + tag objects. Policy follows AWS's
    // documented IAM permissions for Malware Protection for S3.
    const managedRuleArn = `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`;
    const malwareScanRole = new iam.Role(this, 'ReceiptsMalwareScanRole', {
      roleName: `${prefix}-receipts-malware-scan`,
      // Service principal is `malware-protection-plan.*` (the standalone S3
      // Malware Protection plan), NOT `malware-protection.*`. NO trust
      // conditions: AWS's documented trust policy for this role is
      // conditionless, and gating on `aws:SourceAccount` breaks the service's
      // assume-role at plan creation (the ownership-validation step fails as
      // "role does not have the required permissions"). Confused-deputy risk is
      // low — the principal is the GuardDuty service and the role ARN is
      // account-scoped.
      assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com'),
    });
    // EventBridge managed rule GuardDuty creates to receive S3 object events.
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowManagedRuleToSendS3EventsToGuardDuty',
        actions: ['events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets'],
        resources: [managedRuleArn],
        conditions: {
          StringLike: { 'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com' },
        },
      }),
    );
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowGuardDutyToMonitorEventBridgeManagedRule',
        actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
        resources: [managedRuleArn],
      }),
    );
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowEnableS3EventBridgeEvents',
        actions: ['s3:PutBucketNotification', 's3:GetBucketNotification'],
        resources: [this.receiptsBucket.bucketArn],
      }),
    );
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowBucketInspection',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [this.receiptsBucket.bucketArn],
      }),
    );
    // GuardDuty writes a fixed validation object to prove bucket ownership at
    // plan creation. Without this, creation fails: "the provided IAM role does
    // not have the required permissions to validate S3 bucket ownership".
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowPutValidationObject',
        actions: ['s3:PutObject'],
        resources: [this.receiptsBucket.arnForObjects('malware-protection-resource-validation-object')],
      }),
    );
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowMalwareScan',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.receiptsBucket.arnForObjects('*')],
      }),
    );
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowPostScanTag',
        actions: [
          's3:PutObjectTagging',
          's3:GetObjectTagging',
          's3:PutObjectVersionTagging',
          's3:GetObjectVersionTagging',
        ],
        resources: [this.receiptsBucket.arnForObjects('*')],
      }),
    );
    // The bucket is SSE-KMS (masterKey); GuardDuty must decrypt to scan.
    malwareScanRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowDecryptForMalwareScan',
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [masterKey.keyArn],
        conditions: { StringLike: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      }),
    );

    const malwareProtectionPlan = new guardduty.CfnMalwareProtectionPlan(this, 'ReceiptsMalwareProtectionPlan', {
      role: malwareScanRole.roleArn,
      protectedResource: {
        s3Bucket: { bucketName: this.receiptsBucket.bucketName },
      },
      // Tag each object with the scan result so the worker can gate on it.
      actions: { tagging: { status: 'ENABLED' } },
    });
    // CRITICAL: the plan only implicitly depends on the *role* (via roleArn), not
    // on the role's inline policy — `addToPolicy` emits a SEPARATE
    // `AWS::IAM::Policy` resource. Without this explicit dependency CloudFormation
    // creates the empty role, then validates bucket ownership against it BEFORE
    // the policy attaches, failing deterministically with "role does not have the
    // required permissions to validate S3 bucket ownership." Depending on the role
    // construct pulls its DefaultPolicy child into the DependsOn set so the plan
    // waits for the permissions to exist. (AWS re:Post: enable Malware Protection
    // for S3 via CDK/CloudFormation.)
    malwareProtectionPlan.node.addDependency(malwareScanRole);

    this.webRepo = new ecr.Repository(this, 'WebRepo', {
      repositoryName: `${prefix}/web`,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep last 20 images' }],
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: masterKey,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    for (const [key, value] of Object.entries(config.tags)) Tags.of(this).add(key, value);
  }
}
