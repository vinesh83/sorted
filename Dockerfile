FROM node:20-slim

# Install system dependencies for Tesseract OCR
RUN apt-get update && apt-get install -y \
  tesseract-ocr \
  tesseract-ocr-spa \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY shared/package.json shared/

# Install ALL dependencies (need devDependencies for build)
RUN npm ci

# Copy source
COPY . .

# Build everything: shared types → frontend → server
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/app/data/doctriage.db

EXPOSE 3001

# Run the compiled server
CMD ["node", "packages/server/dist/index.js"]
