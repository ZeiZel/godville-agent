FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production GODVILLE_DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN addgroup -S agent && adduser -S agent -G agent && mkdir /data && chown agent:agent /data
USER agent
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon", "--once"]
