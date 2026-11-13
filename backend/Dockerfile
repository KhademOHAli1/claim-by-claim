FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS codex
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.167.0-alpha.4.1 \
    && codex --version

FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dbcade98e669c
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg libatomic1 libgomp1 tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.lock /tmp/requirements.lock
RUN python3 -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements.lock \
    && python3 -c 'from faster_whisper import WhisperModel' \
    && rm /tmp/requirements.lock

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /usr/local/lib/node_modules/@openai/ /usr/local/lib/node_modules/@openai/
RUN ln -s /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && codex --version \
    && groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin runner \
    && install -d -m 0700 -o runner -g runner /home/runner/.codex /var/lib/claim-by-claim \
    && mkdir -p /models/whisper /opt/investigate-and-fact-check

WORKDIR /app
COPY db/d1.mjs db/d1-transport.mjs db/intake.mjs db/knowledge.mjs db/mastodon.mjs db/research.mjs db/research-schema.json db/runner.mjs db/sources.mjs db/transcribe.mjs db/transcribe-local.py db/verify.mjs db/visual.mjs ./db/

ENV HOME=/home/runner \
    PYTHONDONTWRITEBYTECODE=1 \
    CLAIM_BY_CLAIM_DATA_DIR=/var/lib/claim-by-claim \
    CLAIM_BY_CLAIM_REMOTE_MEDIA_ONLY=1 \
    CLAIM_BY_CLAIM_WHISPER_BACKEND=faster-whisper \
    CLAIM_BY_CLAIM_WHISPER_PYTHON=/usr/local/bin/python3 \
    CLAIM_BY_CLAIM_WHISPER_MODEL=/models/whisper \
    CLAIM_BY_CLAIM_FFMPEG=/usr/bin/ffmpeg \
    CLAIM_RESEARCH_CODEX=/usr/local/bin/codex \
    CLAIM_RESEARCH_SKILL_DIR=/opt/investigate-and-fact-check

USER 10001:10001
CMD ["bun", "db/runner.mjs", "--watch"]
