# Official Node image, Linux amd64 digest observed 2026-10-30.
# Image build/resource qualification is pending; see docs/RESOURCE-VERIFICATION.md.
FROM node:24.22.2-bookworm-slim@sha256:a43f7fc3e52e87d12a905f46eea0275def84ca8f2981a5b53fed44d7fb398ee0
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY artifacts/ ./artifacts/
RUN mkdir -p /var/data && chown node:node /var/data
USER node
EXPOSE 10000
CMD ["node", "scripts/testnet-server.mjs"]
