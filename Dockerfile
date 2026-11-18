FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.cjs relay.cjs ./
COPY public ./public
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "--optimize-for-size", "--max-semi-space-size=2", "server.cjs"]

