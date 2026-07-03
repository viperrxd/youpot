# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY . .

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium and its dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_CRASHPAD_PIPE_NAME="" \
    CHROME_DEVEL_SANDBOX=""

WORKDIR /app

COPY --from=build /app .

# Create non-root user + writable dirs for Chrome
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/.config/chromium \
    && mkdir -p /tmp/chrome-crashpad \
    && chown -R appuser:appuser /app /home/appuser /tmp/chrome-crashpad

USER appuser

EXPOSE 8080

CMD ["node", "server.js"]
