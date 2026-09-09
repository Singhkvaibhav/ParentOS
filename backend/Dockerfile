# Multi-stage: the build toolchain never reaches the runtime image.
#
# sharp may compile from source if no prebuilt binary matches the target
# platform, which needs python3/make/g++. Those are ~200MB of compilers and
# headers - useful for five seconds at build time, and pure attack surface
# for the lifetime of the container. So they live in a stage that gets
# thrown away.
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# `npm ci` (not install): installs exactly the lockfile, so an image built
# today matches one built last month rather than silently picking up a new
# transitive dependency.
RUN npm ci --omit=dev

# --- Runtime -------------------------------------------------------------
FROM node:20-slim AS runtime

# curl is for the container healthcheck below. Nothing else is added.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run as an unprivileged user. The node image ships a `node` user for
# exactly this; the default is root, which means a remote-code-execution
# bug in any dependency becomes root in the container.
RUN mkdir -p uploads && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 4000

# Uses the LIVENESS endpoint deliberately, not readiness. A container
# healthcheck decides whether to RESTART the container; pointing it at a
# probe that fails when Postgres is briefly unavailable would restart every
# API container during a database blip - the outage amplification the
# split between /api/health and /api/ready exists to prevent.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/api/health || exit 1

CMD ["node", "server.js"]
