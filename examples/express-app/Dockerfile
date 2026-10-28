# Builds from the PUBLISHED package (npm install), so it works once
# @oneofthegeeks/goto-sms is on npm. Build with this directory as the context.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
# The monorepo pins the workspace link as "*"; outside it npm resolves the registry.
RUN npm install --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    GOTO_SMS_DATA_DIR=/data
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
