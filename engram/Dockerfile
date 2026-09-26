FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
ENV PORT=4100
# Q&A bank vectors computed locally with all-minilm, so the hosted brain does not re-embed 340 texts on a CPU at boot
ENV EMBED_CACHE=deploy/qa-embeddings.json
EXPOSE 4100
CMD ["node_modules/.bin/tsx", "server/index.ts"]
