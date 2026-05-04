FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS production

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript from builder stage
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
