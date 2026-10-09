FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-audit --no-fund \
    && node -e "import('impit').then(() => console.log('impit native import OK'))"

COPY --chown=myuser:myuser . ./
CMD ["node", "src/main.js"]
