FROM node:20-bookworm-slim

# Lightweight Chromium + certificates only (skips 180MB CJK font bloat for ultra-fast Render deploys!)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SIMPLE_CHAT_MODE=1 \
    HEADLESS=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=320"

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
