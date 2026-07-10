FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/txline-client/package.json packages/txline-client/package.json

RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@groundtruth/server", "start"]
