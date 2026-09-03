FROM node:20-slim

# System deps
RUN apt-get update && apt-get install -y ffmpeg curl --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp

# pnpm
RUN npm install -g pnpm@latest

WORKDIR /app

# Copy everything and install
COPY . .
RUN pnpm install --frozen-lockfile

# Build frontend + backend
RUN pnpm --filter @workspace/ytdlp-ui run build
RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
