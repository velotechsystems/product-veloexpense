# VeloExpense production image.
# Multi-stage: deps -> builder -> runner (Next.js standalone output).
#
# One image, three uses (infrastructure/cdk compute-stack.ts):
#   web       the default CMD, `node server.js`
#   database  `node scripts/db-bootstrap.mjs && node scripts/migrate.mjs`
#   tick      `node scripts/tick.mjs /api/internal/<route>` on a schedule
# so the runner carries scripts/ and prisma/migrations/ next to the standalone
# server. `pg` is already in the standalone node_modules because the app uses it.
#
# Build for the deployed platform (Fargate ARM64):
#   docker build --platform linux/arm64 -t veloexpense-web .

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# Amazon RDS certificate authorities for ca-central-1, so the app can connect
# with sslmode=verify-full (docker-entrypoint.sh) instead of trusting whatever
# answers on the database endpoint. NODE_EXTRA_CA_CERTS points here (task
# definition). Fetched at build time; a failed fetch fails the build.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/ca-central-1/ca-central-1-bundle.pem /app/rds-ca.pem

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --home /home/nextjs --create-home --shell /usr/sbin/nologin nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# The database and tick tasks run these against the same standalone node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs /app/scripts/db-bootstrap.mjs /app/scripts/tick.mjs ./scripts/
COPY --from=builder --chown=nextjs:nodejs /app/prisma/migrations ./prisma/migrations
COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
