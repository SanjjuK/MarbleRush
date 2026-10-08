# MarbleRush on Fly.io (see DEPLOY.md). One small container: the Node server and the game files it serves.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# Dependencies first (cached between deploys). --ignore-scripts: no native build; web3.js falls back to pure JS.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The three shared modules the engine imports, then the game. .dockerignore keeps every secret and all runtime data out;
# the only data file that goes in is the public chain.json (token addresses).
COPY js/rng.js js/racers.js js/betting.js ./js/
COPY MarbleRush2D ./MarbleRush2D
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The volume is mounted here (fly.toml). MR_DATA / MR_CHAIN_DIR point at it.
ENV PORT=8080 MR_DATA=/data MR_CHAIN_DIR=/data
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "MarbleRush2D/server/server.mjs"]
