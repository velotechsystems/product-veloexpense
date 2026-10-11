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
 *
 * NOTE on 9000, added after it cost a debugging round: the e2e's own S3 surface
 * (scripts/e2e-storage.mjs) deliberately defaults to 9401 instead, because a local
 * MinIO started with the command below occupies 9000 — and Playwright's port probe
 * cannot tell MinIO from s3rver, so it silently adopted it and three receipt specs
 * failed about uploads. Local MinIO and the e2e can now both run at once.
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
  GetObjectTaggingCommand,
  NoSuchKey,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { UPLOAD_CEILING_BYTES } from './limits';

/** How long a presigned URL stays valid, in seconds. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export interface PresignedUpload {
  url: string;
  /** Headers the browser MUST send on the PUT or the signature will not match. */
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/**
 * Options for an upload link (Wave 2, w2-09 — ExpenseOS's `getUploadUrl` input).
 *
 * `contentLength` is the EXACT byte length the client will PUT: the S3 driver signs it into
 * the link, so storage refuses a body of any other size, and refuses to sign a length past
 * {@link UPLOAD_CEILING_BYTES} at all. Omitted, the link binds no length — what the receipt
 * drawer from before the port does, which checks the size after the upload instead.
 */
export interface UploadOptions {
  contentLength?: number;
  expiresInSeconds?: number;
}

/** Options for a download link. `expiresInSeconds` defaults to {@link DOWNLOAD_URL_TTL_SECONDS}. */
export interface DownloadOptions {
  expiresInSeconds?: number;
}

/** ExpenseOS's refusal: a length must be an integer from 1 byte to the ceiling. */
function assertUploadLength(contentLength: number | undefined): void {
  if (contentLength === undefined) return;
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > UPLOAD_CEILING_BYTES) {
    throw new RangeError(
      `upload contentLength must be an integer from 1 to ${UPLOAD_CEILING_BYTES} bytes; got ${contentLength}`,
    );
  }
}

export interface StoredObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * The outcome of a bounded read (`Storage.read`, `guardedRead`).
 *
 * Ported from ExpenseOS's `@expenseos/storage` types (550b2945, Wave 3 w3-02a).
 */
export type BoundedRead =
  | { ok: true; data: Uint8Array }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'too-large'; size?: number };

/**
 * GuardDuty Malware Protection for S3's verdict on an object, as the worker's scan gate
 * reads it. Ported from ExpenseOS (550b2945).
 */
export type MalwareScanStatus = 'clean' | 'infected' | 'pending' | 'unavailable';

/** The object tag GuardDuty Malware Protection for S3 writes its verdict to. */
export const GUARDDUTY_SCAN_TAG = 'GuardDutyMalwareScanStatus';

export interface Storage {
  presignUpload(key: string, contentType: string, options?: UploadOptions): Promise<PresignedUpload>;
  presignDownload(key: string, filename?: string, options?: DownloadOptions): Promise<string>;
  /** null when the object does not exist — how confirmUpload detects a no-show. */
  head(key: string): Promise<StoredObjectHead | null>;
  delete(key: string): Promise<void>;
  /**
   * VX5-12 — upload a file the SERVER produced, from a local path.
   *
   * ── WHY THIS INTERFACE DID NOT HAVE A WRITE UNTIL NOW ─────────────────────
   *
   * Every object in this product until now was a receipt, and a receipt is
   * uploaded by the BROWSER straight to storage against a presigned URL — which
   * is the whole reason `presignUpload` exists and the reason the bytes never
   * pass through the app. Nothing server-side had anything to store, so the
   * interface had no way to say so. That absence was correct and it is worth
   * knowing it was not an oversight.
   *
   * An export archive is the first object this product MAKES.
   *
   * ── AND WHY IT TAKES A PATH RATHER THAN BYTES ────────────────────────────
   *
   * `put(key, bytes)` would put the whole archive in memory, and the archive's
   * size is a function of how long the tenant has been a customer —
   * `audit_entry` grows forever and is never pruned. The writer streams to a
   * temporary file for exactly that reason, so handing over the path keeps the
   * ceiling at one DEFLATE window instead of the whole export. S3's PutObject
   * takes a stream when it is given a length, which a file has.
   */
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  /**
   * Read an object's bytes, never more than `maxBytes`: the stream is abandoned at
   * `maxBytes` + 1 whatever the object's declared size. A missing object is `missing`, any
   * other failure throws.
   *
   * VeloExpense (w3-02a): the worker reads a receipt to send it to the model, the first
   * thing in this product that reads an object back through the app. Ported from
   * ExpenseOS's `StorageClient.read`; the worker reaches it through `guardedRead`
   * (`./guardedRead`), which HEADs first.
   */
  read(key: string, maxBytes: number): Promise<BoundedRead>;
  /**
   * Read the object's GuardDuty Malware Protection scan-status tag. Maps the
   * `GuardDutyMalwareScanStatus` object tag to a {@link MalwareScanStatus}.
   * FAIL-CLOSED: any tag-read error resolves to `'unavailable'` (never `'clean'`).
   */
  getMalwareScanStatus(key: string): Promise<MalwareScanStatus>;
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

  /**
   * Test helper: the stored bytes, whole.
   *
   * The product's read is `read` (w3-02a, the worker's receipt download), which is
   * bounded; this stays a test affordance beside `put` and `has`.
   */
  body(key: string): Uint8Array | null {
    return this.objects.get(key)?.body ?? null;
  }

  get objectCount() {
    return this.objects.size;
  }

  async presignUpload(key: string, contentType: string, options: UploadOptions = {}): Promise<PresignedUpload> {
    assertUploadLength(options.contentLength);
    const length = options.contentLength === undefined ? '' : `?length=${options.contentLength}`;
    return {
      url: `memory://upload/${encodeURIComponent(key)}${length}`,
      headers: { 'Content-Type': contentType },
      expiresInSeconds: options.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS,
    };
  }

  async presignDownload(key: string, _filename?: string, options: DownloadOptions = {}): Promise<string> {
    return `memory://download/${encodeURIComponent(key)}?ttl=${options.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS}`;
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.body.byteLength, contentType: object.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    // Reads the file whole, which is right HERE and wrong in the S3 driver: this
    // one already holds every object in a Map, so a stream would buy nothing.
    this.objects.set(key, { body: new Uint8Array(await readFile(localPath)), contentType });
  }

  /** Test scan verdicts by key; an object with none set reads as `clean`. */
  private readonly scanVerdicts = new Map<string, MalwareScanStatus>();

  /** Test helper: what GuardDuty's tag would say about `key`. */
  setScanStatus(key: string, status: MalwareScanStatus) {
    this.scanVerdicts.set(key, status);
  }

  async read(key: string, maxBytes: number): Promise<BoundedRead> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError(`read maxBytes must be a positive integer; got ${maxBytes}`);
    }
    const object = this.objects.get(key);
    if (!object) return { ok: false, reason: 'missing' };
    if (object.body.byteLength > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, data: object.body };
  }

  async getMalwareScanStatus(key: string): Promise<MalwareScanStatus> {
    if (!this.objects.has(key)) return 'unavailable';
    return this.scanVerdicts.get(key) ?? 'clean';
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

  async presignUpload(key: string, contentType: string, options: UploadOptions = {}): Promise<PresignedUpload> {
    assertUploadLength(options.contentLength);
    const expiresIn = options.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        // Signed into the link: storage refuses a body of any other length. Never handed
        // back as a header — a browser sets Content-Length from the body itself.
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      }),
      { expiresIn },
    );
    return { url, headers: { 'Content-Type': contentType }, expiresInSeconds: expiresIn };
  }

  async presignDownload(key: string, filename?: string, options: DownloadOptions = {}): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(filename
          ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '')}"` }
          : {}),
      }),
      { expiresIn: options.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS },
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

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    // ContentLength from stat, which is what lets this be a STREAM rather than a
    // buffer: PutObject requires a length for a non-buffer body, and without one
    // the SDK would either buffer the stream itself or need multipart. A local
    // file knows its own size, so neither is necessary.
    const { size } = await stat(localPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  /** Ported from ExpenseOS's S3 `read` (550b2945). */
  async read(key: string, maxBytes: number): Promise<BoundedRead> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError(`read maxBytes must be a positive integer; got ${maxBytes}`);
    }
    let body: unknown;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      body = res.Body;
    } catch (e) {
      // The SDK reports a missing object as `NoSuchKey` on GET and as `NotFound` on HEAD
      // (see `head()`), hence the different class.
      if (e instanceof NoSuchKey) return { ok: false, reason: 'missing' };
      throw e;
    }
    // In Node the SDK's body is a `Readable` (an `IncomingMessage` by default), which is
    // async-iterable. Anything else is a response we cannot bound, so refuse it rather than
    // fall back to an unbounded collect.
    if (!isAsyncIterable(body)) {
      throw new TypeError('GetObject returned a body that cannot be streamed');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const part of body) {
      // `ArrayBuffer.isView`, not `instanceof Uint8Array`: a `Buffer` from another realm
      // (the jsdom test environment, for one) fails `instanceof` while being bytes.
      if (!ArrayBuffer.isView(part)) {
        destroy(body);
        throw new TypeError('GetObject body yielded a non-binary chunk');
      }
      const chunk = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      total += chunk.byteLength;
      if (total > maxBytes) {
        // Stop pulling. Returning out of the loop already destroys a `Readable` (its async
        // iterator's `return()` does), but destroying it explicitly does not rest on that.
        destroy(body);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(chunk);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, data };
  }

  /** Ported from ExpenseOS's S3 `getMalwareScanStatus` (550b2945). */
  async getMalwareScanStatus(key: string): Promise<MalwareScanStatus> {
    let value: string | undefined;
    try {
      const res = await this.client.send(
        new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }),
      );
      value = res.TagSet?.find((t) => t.Key === GUARDDUTY_SCAN_TAG)?.Value;
    } catch {
      // Tag read failed (transport/auth/object gone) — fail closed.
      return 'unavailable';
    }
    switch (value) {
      case 'NO_THREATS_FOUND':
        return 'clean';
      case 'THREATS_FOUND':
        return 'infected';
      case undefined:
        // No scan-status tag yet — GuardDuty hasn't finished scanning.
        return 'pending';
      default:
        // ACCESS_DENIED / UNSUPPORTED / FAILED / anything unexpected — fail closed.
        return 'unavailable';
    }
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function destroy(body: unknown): void {
  const d = (body as { destroy?: unknown }).destroy;
  if (typeof d === 'function') d.call(body);
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
