FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

# Skip Puppeteer's bundled browser download because this project runs on Playwright Firefox.
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p \
    /app/logs \
    /app/runtime \
    /app/screenshots \
    /app/servicePuppeteer/dataDir

EXPOSE 3201

# Run under Xvfb so the container can still work if a flow needs non-headless Firefox.
CMD ["xvfb-run", "-a", "npm", "start"]
