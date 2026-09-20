FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production GODVILLE_DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json bun.lock ./
# Playwright's Debian dependency installer calls apt, so use HTTPS repository URLs.
RUN find /etc/apt -type f \( -name "sources.list" -o -name "*.sources" \) -exec sed -i -e 's|http://deb.debian.org|https://deb.debian.org|g' -e 's|http://security.debian.org|https://security.debian.org|g' {} + \
  && bun install --frozen-lockfile --production \
  && bun ./node_modules/playwright/cli.js install --with-deps chromium
COPY --from=build /app/dist ./dist
RUN mkdir -p /data /browser-state && chown -R bun:bun /data /browser-state /ms-playwright
USER bun
VOLUME ["/data", "/browser-state"]
ENTRYPOINT ["bun", "dist/cli.js"]
CMD ["browser-check"]
