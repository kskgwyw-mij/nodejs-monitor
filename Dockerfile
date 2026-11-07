# syntax=docker/dockerfile:1
# For reproducible builds, pin the base image by digest as well, e.g.
#   FROM node:25.9.0-alpine@sha256:<digest>
ARG NODE_IMAGE=node:25.9.0-alpine

# ---- Install production dependencies ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g --force npm@11.6.2 yarn@1.22.22
COPY package.json yarn.lock .yarnrc ./
RUN yarn install --frozen-lockfile --production --ignore-scripts --non-interactive \
 && yarn cache clean

# ---- Runtime image ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/app.db

# The runtime never needs a package manager: remove them to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /app/data && chown node:node /app/data

WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public

# Unprivileged user; application code is root-owned and therefore read-only to it.
USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

# Node permission model: read only /app, write only /app/data, no child processes/workers/addons.
CMD ["node", "--permission", "--allow-net", "--allow-fs-read=/app", "--allow-fs-write=/app/data", "src/server.js"]
