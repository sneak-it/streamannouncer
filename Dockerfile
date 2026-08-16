FROM node:24-alpine AS builder

WORKDIR /app

# better-sqlite3 ships no musl prebuilds, so node-gyp compiles it here
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop devDependencies, keeping the already-compiled better-sqlite3 binding
RUN npm prune --omit=dev

FROM node:24-alpine AS production

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy pruned production deps and compiled JavaScript from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create the data directory for the SQLite database and set ownership
RUN mkdir -p /app/data && chown node:node /app/data

# Install timezone data for Alpine Linux
RUN apk add --no-cache tzdata

# Switch to the unprivileged 'node' user provided by the base image
USER node

# Set environment variables
ENV NODE_ENV=production
ENV TZ=America/New_York

# Run the bot
CMD ["node", "dist/server.js"]

# Health check: the bot refreshes /tmp/healthy at the end of every completed
# poll cycle. Require it to have been touched within the last 11 minutes (>2
# poll intervals) so a stale-but-present file reads as unhealthy. Note: plain
# Docker/Compose does not restart on unhealthy — recovery comes from the
# in-process watchdog exiting; this probe is for observability/orchestrators.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD find /tmp/healthy -mmin -11 2>/dev/null | grep -q . || exit 1
