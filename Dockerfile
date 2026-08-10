# Whyzr hosted app.
#
# git is a runtime dependency, not a build tool: every kid gets a real git
# clone of this repo, and journal entries are real commits.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm ci, never npm install: install rewrites package-lock.json, which the
# eval runner then refuses as a dirty tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The app clones ITSELF for each kid, so the image must contain a valid git
# repo with the age branches present. Rebuild the repo state inside the image
# rather than relying on whatever .git the build context carried.
RUN git config --global user.email "whyzr@localhost" \
  && git config --global user.name "Whyzr" \
  && git config --global --add safe.directory /app

# Persistent volume: kid repos, registry, transcripts. Never inside a repo.
ENV WHYZR_DATA_DIR=/data
VOLUME ["/data"]

# Run as a non-root user that can still write /data and /app.
RUN useradd --create-home --uid 10001 whyzr \
  && mkdir -p /data \
  && chown -R whyzr:whyzr /app /data
USER whyzr

ENV NODE_ENV=production
ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/app.mjs"]
