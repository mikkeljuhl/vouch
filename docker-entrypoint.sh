#!/usr/bin/env bash
# Entrypoint for the vouch runner image. Two modes:
#
# GitHub Action mode (GITHUB_WORKSPACE set): run the consumer's checked-out tests
# with JUnit, then merge console messages into the report and emit annotations +
# a job summary. Inputs arrive as INPUT_* env vars from action.yml.
#
# Plain mode (`docker run -v "$PWD/tests:/app/tests" ...`): exec `bun test` with
# any passed args, in /app where the framework's node_modules symlink lives.
set -euo pipefail

if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  cd "$GITHUB_WORKSPACE"

  # Make the framework resolvable by package name for the consumer's tests, which
  # live in the workspace (not under /app). Points at the image's copy.
  mkdir -p node_modules/@mikkeljuhl
  ln -sfn /app node_modules/@mikkeljuhl/vouch

  junit="${INPUT_JUNIT_FILE:-reports/junit.xml}"
  mkdir -p "$(dirname "$junit")"

  # Tee Bun's console output: its JUnit <failure> carries only the error type, so
  # ci-summary merges the full message (our structured diff) from the console.
  set +e
  bun test ${INPUT_PATHS:-} --reporter=junit --reporter-outfile="$junit" 2>&1 | tee /tmp/vouch-console.log
  status=${PIPESTATUS[0]}
  set -e

  # Annotations + job summary + enriched JUnit. Never let reporting mask the
  # test exit status.
  bun /app/scripts/ci-summary.mjs "$junit" /tmp/vouch-console.log || true
  exit "$status"
fi

cd /app
exec bun test "$@"
