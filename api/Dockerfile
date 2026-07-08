# api/Dockerfile — xmb-api (Node 20, multi-stage)
# NOTE: build context is the REPO ROOT (COPY paths are api/... and web/...):
#   docker buildx build -f api/Dockerfile --platform linux/amd64 \
#     -t docker.io/yourbr0ther/psp-xmb-api:phase2b --load .

# --- web build: compile the SPA to /web/dist -------------------------------
FROM node:20-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- api build: compile TypeScript, prune dev deps -------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm install
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY api/package.json ./
# SPA served statically by server.ts at WEB_DIR (default /app/web).
COPY --from=web-build /web/dist /app/web
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
