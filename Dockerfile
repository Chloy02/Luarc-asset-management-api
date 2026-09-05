FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY openapi.yaml ./
USER node
EXPOSE 3000
# No build step: Node 24 executes TypeScript directly (types are erased at load time).
CMD ["node", "src/server.ts"]
