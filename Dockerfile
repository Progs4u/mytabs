ARG DENO_VERSION=2.9.5

# Build dist
# Extremely slow on multi-arch builds
FROM denoland/deno:debian-${DENO_VERSION} AS builder
WORKDIR /app

RUN mkdir -p /app/data && chown -R deno:deno /app/data
RUN mkdir -p /app/dist && chown -R deno:deno /app/dist

USER deno
COPY --chown=deno:deno ./frontend /app/frontend
COPY --chown=deno:deno ./backend/common.ts /app/backend/common.ts
# progs4u: vite.config.ts reads ../deno.jsonc for the app version - upstream's
# builder stage never runs in their release flow, so this copy was missing.
COPY --chown=deno:deno ./deno.jsonc /app/deno.jsonc
WORKDIR /app/frontend
RUN deno install && \
    deno task build

# Main image
FROM denoland/deno:debian-${DENO_VERSION} AS release
WORKDIR /app

EXPOSE 47777

RUN mkdir -p /app/data && chown -R deno:deno /app/data

# progs4u: poppler-utils provides pdftotext/pdfinfo. The importer uses it to record what
# is printed inside each PDF (so the chords become searchable) and to tell a born-digital
# file from a scan that would need OCR.
RUN apt update && \
    apt --yes --no-install-recommends install gosu poppler-utils && \
    rm -rf /var/lib/apt/lists/*

USER deno

COPY --chown=deno:deno ./extra /app/extra
COPY --chown=deno:deno ./backend /app/backend
COPY --chown=deno:deno ./deno.jsonc /app/deno.jsonc

# progs4u: build the frontend inside the builder stage so a plain
# `docker build .` works with no Deno toolchain on the host.
COPY --chown=deno:deno --from=builder /app/dist /app/dist

# Install and cache dependencies
RUN deno install && \
    deno cache ./backend/main.ts && \
    timeout 10s deno -A main.ts || exit 0

# Switch back to root, I found that it will cause permission issues if the user does not set permissions correctly
# Use PUID / PGID to switch back to `deno` user instead
USER root

RUN chmod +x /app/extra/docker-entrypoint.sh

ENTRYPOINT ["/app/extra/docker-entrypoint.sh"]
CMD ["deno", "task", "start"]

# ---------------------------------------------------------------------------
# progs4u dev-only stage: the production image plus the frontend devDependencies
# and the Playwright browsers, so the repo's unit and e2e suites run inside the
# container. Built by compose.dev.yaml (`target: dev`) from the ./dev checkout and
# never deployed. NOTE: this stage must live in THIS file, not in a Dockerfile that
# starts FROM the production image - otherwise the dev container would run the
# deploy tree's code (src/) instead of the branch under test.
FROM release AS dev

USER root

# Chromium is downloaded here rather than into a user cache, so the container user
# can read it; --with-deps pulls the shared libraries it links against.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --chown=deno:deno ./frontend /app/frontend

WORKDIR /app/frontend
RUN deno install && \
    deno run -A npm:playwright@1.62.1 install --with-deps chromium && \
    chmod -R a+rX /ms-playwright && \
    rm -rf /root/.npm /var/lib/apt/lists/*

WORKDIR /app
