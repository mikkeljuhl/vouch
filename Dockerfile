# Portable test runner: Bun + the framework preinstalled, so teams without a JS
# toolchain can run API tests with one `docker run`. (DESIGN.md §1/§3.)
#
# Self-test (default):
#   docker build -t apitest .
#   docker run --rm apitest                      # runs the baked dogfood suite
#
# Run YOUR tests (mount them over /app/tests):
#   docker run --rm -v "$PWD/tests:/app/tests" apitest
#   # emit JUnit to the host:
#   docker run --rm -v "$PWD/tests:/app/tests" -v "$PWD/reports:/app/reports" \
#     apitest --reporter=junit --reporter-outfile=/app/reports/junit.xml
#
# Your test files import the framework by name: `from '@your-org/apitest'`
# (resolved via the node_modules symlink created below).

FROM oven/bun:1

WORKDIR /app

# Install deps first for layer caching. `bun install` runs the `prepare` script
# (tsup) to build dist/, which the package's `exports` map points at.
COPY package.json bun.lock tsconfig.json tsup.config.ts ./
COPY src ./src
RUN bun install --frozen-lockfile

# Make the package importable by its published name for mounted user tests:
# node_modules/@your-org/apitest -> /app, resolved through the exports map.
RUN mkdir -p node_modules/@your-org && ln -sf /app node_modules/@your-org/apitest

# Bake the dogfood suite + reporting script so `docker run` self-tests by default.
COPY tests ./tests
COPY scripts ./scripts

# `bun test` is the entrypoint; extra args (e.g. --reporter=junit) pass through.
ENTRYPOINT ["bun", "test"]
