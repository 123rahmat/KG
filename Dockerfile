# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# node-pty is a runtime dependency for the terminal. Build its native module in
# an isolated dependency stage, keeping compilers and headers out of production.
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
# Keep the pinned base image for reproducibility, then apply current Alpine
# security fixes. The production container runs Node directly and never needs
# npm/npx/corepack, so remove those global package-manager trees from the
# runtime layer as additional attack-surface and vulnerability reduction.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /app
ENV NODE_ENV=production

# Keep the immutable Node base pin, then apply current Alpine security fixes.
# npm/npx are build-time tooling only; the production process launches with
# node directly, so remove npm's global dependency tree from the runtime image.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Run as a non-root user. The base image ships one; use it rather than
# creating another.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# Readiness, not liveness: this is the probe that knows about the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init shim: the app handles SIGTERM itself and drains in-flight requests.
CMD ["node", "server.js"]
