FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
# Debian rather than Alpine: the Matrix crypto bindings ship no musl build.
# Runs as an unprivileged user on a read-only root filesystem: nothing is written at runtime
USER 10000:10000
EXPOSE 8080
CMD ["node", "dist/index.js"]
