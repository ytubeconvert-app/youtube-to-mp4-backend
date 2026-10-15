FROM node:20-bookworm-slim

# Install system dependencies: Python 3, FFmpeg, CA certificates, curl, git
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with EJS dependencies & PO-Token providers
RUN pip3 install --no-cache-dir --break-system-packages --upgrade "yt-dlp[default]" yt-dlp-ejs bgutil-ytdlp-pot-provider

# Build official bgutil PO-Token provider server for generating Proof-of-Origin tokens on cloud IPs
RUN git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /app/pot-provider && \
    cd /app/pot-provider/server && \
    npm ci && \
    npx tsc

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
ENV YT_DLP_POT_PROVIDER_URL=http://127.0.0.1:4416

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

CMD ["node", "dist/server.js"]
