FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker/loop.sh ./docker/loop.sh

ENV NODE_ENV=production \
    STATE_FILE=/data/state.json \
    RUN_INTERVAL=1200

# Claude Code CLI for the weekly digest (`claude -p`); authenticates with CLAUDE_CODE_OAUTH_TOKEN from .env
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

RUN chmod +x docker/loop.sh && mkdir /data && chown pwuser /data
USER pwuser
VOLUME /data

ENTRYPOINT ["./docker/loop.sh"]
