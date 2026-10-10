FROM node:20-bookworm-slim

# Install system dependencies: Python 3, FFmpeg, CA certificates, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with latest upstream release
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp

WORKDIR /app

# Install Node dependencies
COPY package.json tsconfig.json ./
RUN npm install

# Copy source code and build
COPY src ./src
RUN npm run build

# Create ephemeral download storage
RUN mkdir -p /app/temp_downloads && chmod 777 /app/temp_downloads

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV TEMP_DIR=/app/temp_downloads

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

CMD ["node", "dist/server.js"]
