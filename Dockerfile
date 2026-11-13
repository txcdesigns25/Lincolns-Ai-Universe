# One image for every service. Set SERVICE_ROLE=web or SERVICE_ROLE=worker on each Railway service.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @universe/web build
ENV NODE_ENV=production
CMD ["sh", "scripts/start.sh"]
