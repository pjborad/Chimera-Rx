# Chimera Rx: one image that builds the web app and serves it with the API on port 4000.
# Synthetic data only. Demo environment, not for clinical use.
FROM node:24-slim

RUN npm install --global pnpm@12.16.1
WORKDIR /app

# Install with the lockfile first so this layer caches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/gs1/package.json packages/gs1/
COPY packages/coroner/package.json packages/coroner/
COPY packages/summoner/package.json packages/summoner/
RUN pnpm install --frozen-lockfile

COPY . .
# OCR model for the browser OCR (downloaded once, at build), then the web build the API serves.
RUN pnpm --filter @chimera-rx/web run ocr:assets && pnpm build:web

ENV LG_API_PORT=4000 \
    NODE_ENV=production \
    DATA_DIR=/app/data \
    LLM_PROVIDER=none \
    SEED_SYNTHETIC=1
EXPOSE 4000
VOLUME ["/app/data"]
CMD ["pnpm", "--filter", "@chimera-rx/api", "run", "start"]
