FROM node:22-slim

# Install build tools for native modules (better-sqlite3 needs node-gyp → python3 + make + g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy everything (patches dir needed before pnpm install)
COPY . .

# Install dependencies with corepack (pnpm version pinned in packageManager field)
# onlyBuiltDependencies in package.json allows better-sqlite3 postinstall (node-gyp rebuild)
RUN npm install -g corepack@latest && corepack pnpm install

# Build frontend (vite) + server (esbuild)
RUN corepack pnpm run build

# Create data directory for SQLite backtest database
RUN mkdir -p /app/data

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
