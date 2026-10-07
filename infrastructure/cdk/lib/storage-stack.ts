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
 *   · the inbound-mail bucket — receipts by email is not ported.
 *   · GuardDuty Malware Protection — ExpenseOS's WORKER reads the scan tag
 *     before extracting. VeloExpense has no receipt extraction yet, so nothing
 *     would read the verdict; turning it on is part of that port.
 *   · intelligent tiering — receipts here are small and recent; revisit at volume.
 *   · the worker repository — there is no worker image.
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_ecr as ecr,
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
