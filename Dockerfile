# Use Node.js 18 or higher as required by youtube-po-token-generator
FROM node:20

WORKDIR /app

# Install dependencies required by Puppeteer/Chromium (used internally by the generator)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm install --ignore-scripts

COPY server.js ./

# Set environment variables to prevent Chrome crashpad errors in Docker
ENV CHROME_CRASHPAD_PIPE_NAME=""
ENV CHROME_DEVEL_SANDBOX=""

# Optional: Disable sandbox if facing crashpad errors
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 8080

CMD ["node", "server.js"]
