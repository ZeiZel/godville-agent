FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production GODVILLE_DATA_DIR=/data
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
ENTRYPOINT ["bun", "dist/cli.js"]
CMD ["daemon", "--once"]
