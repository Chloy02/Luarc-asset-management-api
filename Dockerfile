FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY openapi.yaml ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
# No build step: Node 24 executes TypeScript directly (types are erased at load time).
CMD ["node", "src/server.ts"]
