/**
 * VX1-5 — the object-storage seam.
 *
 * One narrow interface, two drivers:
 *   S3Storage     — AWS S3 in prod, MinIO locally (same API; MinIO needs
 *                   STORAGE_ENDPOINT + path-style addressing).
 *   MemoryStorage — tests. Keeps objects in a Map and signs fake URLs, so CI
 *                   needs no credentials and no running MinIO.
 *
 * Bytes never pass through the Next server: the browser PUTs straight to
 * storage with a presigned URL and GETs the same way. The app only signs URLs,
 * verifies what actually landed, and records rows.
 *
 * Environment (S3 driver):
 *   STORAGE_DRIVER            's3' | 'memory'        (default 's3')
 *   STORAGE_BUCKET            bucket name                    [required for s3]
 *   STORAGE_REGION            e.g. 'ca-central-1'            (default us-east-1)
 *   STORAGE_ENDPOINT          MinIO URL, e.g. http://localhost:9000  (optional)
 *   STORAGE_FORCE_PATH_STYLE  'true' for MinIO                      (optional)
 *   STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY  (optional; falls back to
 *                             the ambient AWS credential chain — an IAM role in
 *                             prod, AWS_* env vars locally)
 *
 * Local MinIO:
 *   docker run -d --name velo-minio -p 9000:9000 -p 9001:9001 \
 *     -e MINIO_ROOT_USER=velo -e MINIO_ROOT_PASSWORD=velominio \
 *     minio/minio server /data --console-address ":9001"
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** How long a presigned URL stays valid, in seconds. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export interface PresignedUpload {
  url: string;
  /** Headers the browser MUST send on the PUT or the signature will not match. */
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface StoredObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

export interface Storage {
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  presignDownload(key: string, filename?: string): Promise<string>;
  /** null when the object does not exist — how confirmUpload detects a no-show. */
  head(key: string): Promise<StoredObjectHead | null>;
  delete(key: string): Promise<void>;
}

/* ── in-memory driver (tests) ──────────────────────────────────────────────── */

export class MemoryStorage implements Storage {
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  /** Test helper: stand in for the browser completing its PUT. */
  put(key: string, body: Uint8Array | string, contentType = 'application/octet-stream') {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: bytes, contentType });
  }

  has(key: string) {
    return this.objects.has(key);
  }

  get objectCount() {
    return this.objects.size;
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    return {
      url: `memory://upload/${encodeURIComponent(key)}`,
      headers: { 'Content-Type': contentType },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async presignDownload(key: string): Promise<string> {
    return `memory://download/${encodeURIComponent(key)}`;
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.body.byteLength, contentType: object.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/* ── S3 / MinIO driver ─────────────────────────────────────────────────────── */

export class S3Storage implements Storage {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(bucket: string, client?: S3Client) {
    this.bucket = bucket;
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
    this.client =
      client ??
      new S3Client({
        region: process.env.STORAGE_REGION ?? 'us-east-1',
        ...(process.env.STORAGE_ENDPOINT ? { endpoint: process.env.STORAGE_ENDPOINT } : {}),
        forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      });
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
    return { url, headers: { 'Content-Type': contentType }, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
  }

  async presignDownload(key: string, filename?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(filename
          ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '')}"` }
          : {}),
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: Number(result.ContentLength ?? 0), contentType: result.ContentType ?? null };
    } catch (err) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/* ── factory ───────────────────────────────────────────────────────────────── */

let override: Storage | null = null;
let cached: Storage | null = null;

/** Tests inject MemoryStorage here; pass null to restore env-driven behaviour. */
export function setStorage(storage: Storage | null) {
  override = storage;
  if (storage) cached = null;
}

export function getStorage(): Storage {
  if (override) return override;
  if (cached) return cached;

  if ((process.env.STORAGE_DRIVER ?? 's3') === 'memory') {
    cached = new MemoryStorage();
    return cached;
  }

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) {
    throw new Error(
      'storage is not configured: set STORAGE_BUCKET (plus STORAGE_ENDPOINT for MinIO), or STORAGE_DRIVER=memory',
    );
  }
  cached = new S3Storage(bucket);
  return cached;
}
