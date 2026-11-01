FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
ENV MOTE_USDC_ENABLED=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY legacy/package.json legacy/package-lock.json ./legacy/
RUN npm ci --prefix legacy --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
USER node
CMD ["node","scripts/combined-server.mjs"]
