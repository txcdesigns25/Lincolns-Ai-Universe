# One image for both services. Railway runs it twice with different start commands:
#   web:    pnpm start:web
#   worker: pnpm start:worker   (runs migrations + seed first, then the worker)
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @universe/web build
ENV NODE_ENV=production
CMD ["pnpm", "start:worker"]
