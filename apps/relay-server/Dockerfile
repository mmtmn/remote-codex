FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/relay-server ./apps/relay-server

RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @remote-codex/relay-server build

ENV PORT=8787

EXPOSE 8787

CMD ["node", "apps/relay-server/dist/index.js"]
