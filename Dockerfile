# VeloExpense production image.
# Multi-stage: deps -> builder -> runner (Next.js standalone output).
#
# One image, four uses (infrastructure/cdk compute-stack.ts):
#   web       the default CMD, `node server.js`
#   database  `node scripts/db-bootstrap.mjs && node scripts/migrate.mjs`
#   tick      `node scripts/tick.mjs /api/internal/<route>` on a schedule
#   worker    `node worker/dist/main.mjs`, the BullMQ consumer (w3-00). ExpenseOS builds
#             the worker its own image; here it is one bundled file in this one
#             (worker/build.mjs says why).
# so the runner carries scripts/ and prisma/migrations/ next to the standalone
# server. `pg` is already in the standalone node_modules because the app uses it.
#
# Build for the deployed platform (Fargate ARM64), as a plain image rather than an
# index, so ECR's scan-on-push scans it:
#   docker build --platform linux/arm64 --provenance=false --sbom=false -t veloexpense-web .
#
# ALPINE, as ExpenseOS's docker/web/Dockerfile is (node:26-alpine there; Node 24 here,
# the version this repo pins). The first image was node:24-bookworm-slim, and ECR's scan
# of it (6 Oct 2026) found 5 CRITICAL and 14 HIGH — every one in a Debian base package
# the app never runs (perl, util-linux, gcc-12 runtime libs, zlib). Alpine carries none
# of perl or util-linux, and every stage is Alpine so npm installs the musl builds of
# native packages (sharp) that the runner can load.
#
# PULLED FROM ECR PUBLIC, not Docker Hub (f15). `public.ecr.aws/docker/library/*` is
# AWS's mirror of Docker's official images, the same images by the same tags. Docker
# Hub's anonymous pull limit is per IP and GitHub's runners share IPs, so CI's image
# build failed with 429 Too Many Requests on busy days (#174). The mirror's anonymous
# limit is far higher and needs no credential, and the deploy build pulls from the
# same place, so CI and dev build from one source.

FROM public.ecr.aws/docker/library/node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build
RUN npm run worker:build

FROM public.ecr.aws/docker/library/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# APK_REPO_SCHEME is "https" (the default) or "http". Pass
#   --build-arg APK_REPO_SCHEME=http
# only on a network that re-signs TLS to the Alpine CDN with a certificate authority the
# container does not hold: John's Mac sits behind E Inc's Cloudflare Gateway, which does
# that for dl-cdn.alpinelinux.org (found 6 Oct 2026). Over http, apk still verifies every
# index and package against the Alpine signing keys shipped in the base image, so a
# tampered package fails the build. What http gives up: privacy of which packages are
# fetched, and protection from being served an older, still-signed index. ECR's scan of
# the result reports any stale package that would let in. The repositories file goes
# back to https before this layer ends, so the image never carries an http source.
ARG APK_REPO_SCHEME=https

# tini (PID 1, signal handling) is /sbin/tini on Alpine. Then: apply the base image's
# pending security updates, and remove npm/npx/corepack — the running image only ever
# runs `node`, and npm's own dependency tree is a scanner finding waiting to happen.
RUN case "$APK_REPO_SCHEME" in https|http) ;; *) echo "APK_REPO_SCHEME must be https or http" >&2; exit 1 ;; esac \
 && sed -i "s#^https://#${APK_REPO_SCHEME}://#" /etc/apk/repositories \
 && apk add --no-cache tini \
 && apk upgrade --no-cache \
 && sed -i 's#^http://#https://#' /etc/apk/repositories \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Amazon RDS certificate authorities for ca-central-1, so the app can connect
# with sslmode=verify-full (docker-entrypoint.sh) instead of trusting whatever
# answers on the database endpoint. NODE_EXTRA_CA_CERTS points here (task
# definition). Fetched at build time; a failed fetch fails the build.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/ca-central-1/ca-central-1-bundle.pem /app/rds-ca.pem

RUN addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs -h /home/nextjs -s /sbin/nologin nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# The database and tick tasks run these against the same standalone node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs /app/scripts/db-bootstrap.mjs /app/scripts/tick.mjs ./scripts/
COPY --from=builder --chown=nextjs:nodejs /app/prisma/migrations ./prisma/migrations
# The worker: one bundled file. A native package it keeps external (worker/build.mjs
# NATIVE_EXTERNALS) has to be in node_modules beside it: `sharp` (receipt images, w3-02a),
# which the standalone node_modules above already carries because the web app imports the
# same extraction package. A worker bundle that cannot load it fails at import, before it
# connects to anything — which is what the deploy's image check runs.
COPY --from=builder --chown=nextjs:nodejs /app/worker/dist/main.mjs ./worker/dist/main.mjs
COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
