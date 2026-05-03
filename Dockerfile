FROM node:25-alpine AS production

# Set working directory
WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies and tsx for running the TypeScript file
RUN npm ci --omit=dev && npm install tsx

# Copy the rest of the application code and set ownership to the 'node' user
COPY --chown=node:node . .

# Create the data directory for the SQLite database and set ownership
RUN mkdir -p /app/data && chown node:node /app/data

# Switch to the unprivileged 'node' user provided by the base image
USER node

# Set environment variable
ENV NODE_ENV=production

# Run the bot
CMD ["npx", "tsx", "server.ts"]
