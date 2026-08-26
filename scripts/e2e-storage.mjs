/**
 * VX1-9 — an S3 surface for the e2e run.
 *
 * The receipt flow (VX1-5) has the browser PUT straight to object storage with
 * a presigned URL, so an end-to-end test needs something that actually speaks
 * S3 — MemoryStorage signs `memory://` URLs no browser can fetch, which is why
 * the vitest suites can be green while a real upload is broken.
 *
 * s3rver (a devDependency) gives us that in one Node process: no Docker, no
 * credentials, nothing for CI or a laptop to install. It validates the SigV4
 * presigned URL and answers the CORS preflight, which is the pair that breaks
 * in practice. MinIO/S3 remain the real drivers — see lib/storage/index.ts.
 *
 *   node scripts/e2e-storage.mjs        # foreground, Ctrl-C to stop
 */
import { rm } from 'node:fs/promises';
import S3rver from 's3rver';

const PORT = Number(process.env.E2E_STORAGE_PORT ?? 9000);
const BUCKET = process.env.STORAGE_BUCKET ?? 'veloexpense-receipts';
const ORIGIN = process.env.E2E_APP_ORIGIN ?? 'http://localhost:3000';
const DIRECTORY = process.env.E2E_STORAGE_DIR ?? '.e2e-storage';

// The CORS rule the handoff warns about: without it every browser upload fails
// while every server-side test passes. Making the e2e depend on it means a
// regression here fails CI instead of surfacing in someone's browser.
const CORS = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>${ORIGIN}</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
  </CORSRule>
</CORSConfiguration>`;

await rm(DIRECTORY, { recursive: true, force: true });

const server = new S3rver({
  address: '127.0.0.1',
  port: PORT,
  silent: true,
  directory: DIRECTORY,
  configureBuckets: [{ name: BUCKET, configs: [CORS] }],
});

await server.run();
console.log(`e2e storage listening on http://127.0.0.1:${PORT} (bucket ${BUCKET})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
