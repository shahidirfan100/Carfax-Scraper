# Use the official Playwright Firefox base image
FROM apify/actor-node-playwright-firefox:24-1.59.1

# Standard setup
RUN npm ls @crawlee/core apify playwright

COPY --chown=myuser:myuser package*.json Dockerfile ./

# Ensure Playwright version matches
RUN node check-playwright-version.mjs

RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
