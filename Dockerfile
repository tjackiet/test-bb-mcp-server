# Dockerfile (TS/tsx 版 MCP Server 用)
FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
# This leverages Docker's build cache. `npm ci` will only run again
# if package.json or package-lock.json has changed.
COPY package.json package-lock.json ./
RUN npm ci

# Copy lightweight-charts standalone js to assets folder
RUN mkdir -p assets && \
    cp node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js assets/lightweight-charts.standalone.js

# Copy the rest of the application's source code
COPY src ./src
COPY tools ./tools
COPY lib ./lib

# Set the environment to production
ENV NODE_ENV=production

# Expose the port the app runs on (optional but good practice)
# ※サーバーが特定のポートをリッスンする場合に指定します。
#   現状のStdioServerTransportでは不要ですが、将来的にWebサーバー化するなら必要です。
# EXPOSE 1337

# Define the entry point for the container
ENTRYPOINT ["npx", "tsx", "src/server.ts"]