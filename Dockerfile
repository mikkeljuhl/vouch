# Portable test runner: Bun + the framework preinstalled, so teams without a JS
# toolchain can run API tests with one `docker run`.
#
# Self-test (default):
#   docker build -t vouch .
#   docker run --rm vouch                      # runs the baked dogfood suite
#
# Run YOUR tests (mount them over /app/tests):
#   docker run --rm -v "$PWD/tests:/app/tests" vouch
#   # emit JUnit to the host:
#   docker run --rm -v "$PWD/tests:/app/tests" -v "$PWD/reports:/app/reports" \
#     vouch --reporter=junit --reporter-outfile=/app/reports/junit.xml
#
# Your test files import the framework by name: `from '@mikkeljuhl/vouch'`
# (resolved via the node_modules symlink created below).

FROM oven/bun:1

WORKDIR /app

# Install deps first for layer caching. The package ships TypeScript source —
# no runtime build — so there's nothing to compile to run; deps are dev-only
# tooling. `bun install` runs the package's `prepare` (tsc -p tsconfig.build.json)
# to emit `.d.ts` into dist/, so we copy tsconfig.build.json too. The image runs
# the TS source directly (the `bun` export condition → ./src/index.ts); dist/ is
# not needed at runtime, but emitting it keeps `prepare` honest in the image.
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY src ./src
# scripts/ must be present before install: `prepare` runs scripts/gen-version.mjs.
COPY scripts ./scripts
RUN bun install --frozen-lockfile

# Make the package importable by its published name for mounted user tests:
# node_modules/@mikkeljuhl/vouch -> /app, resolved through the exports map
# (which points at ./src/index.ts — Bun runs the TS source directly).
RUN mkdir -p node_modules/@mikkeljuhl && ln -sf /app node_modules/@mikkeljuhl/vouch

# Bake the dogfood suite so `docker run` self-tests by default.
COPY tests ./tests
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# In a GitHub Action (GITHUB_WORKSPACE set) the entrypoint runs the consumer's
# workspace tests with JUnit + annotations + summary; otherwise it execs
# `bun test "$@"` for plain `docker run` (extra args pass through).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
