# Google Maps List Organizer - Docker Container
# Includes Chrome + noVNC for remote browser access + web API

FROM node:20-bookworm

# Install dependencies for Chrome, VNC, and noVNC
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    # VNC and desktop
    xvfb \
    x11vnc \
    fluxbox \
    # noVNC
    novnc \
    websockify \
    # Utilities
    supervisor \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set up working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Install Playwright browsers (Chromium only, for backup)
RUN pnpm exec playwright install chromium

# Copy application code
COPY . .

# Create directories
RUN mkdir -p /app/tmp /app/blackhole /app/data /chrome-data && echo "[]" > /app/data/master-locations.json

# Set up supervisor config for multiple processes
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# VNC and noVNC ports, plus web API
EXPOSE 5900 6080 3001

# Environment variables
ENV DISPLAY=:99
ENV CHROME_DATA_DIR=/chrome-data
ENV API_TOKEN=""

# Start supervisor (manages Xvfb, VNC, noVNC, Chrome, and API server)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
