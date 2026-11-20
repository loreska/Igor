FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MALLOC_ARENA_MAX=2
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.cjs relay.cjs ./
COPY public ./public
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "--optimize-for-size", "--max-semi-space-size=1", "server.cjs"]
