FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Claude Code CLI for the weekly digest (`claude -p`); authenticates with CLAUDE_CODE_OAUTH_TOKEN from .env.
# Installed first so source changes do not invalidate this layer; bump the version deliberately.
ARG CLAUDE_CODE_VERSION=2.1.287
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --chmod=755 docker/loop.sh ./docker/loop.sh

ENV NODE_ENV=production \
    STATE_FILE=/data/state.json

RUN mkdir /data && chown pwuser /data
USER pwuser
VOLUME /data

ENTRYPOINT ["./docker/loop.sh"]
