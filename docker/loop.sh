#!/bin/sh
# Runs one pass every $RUN_INTERVAL seconds; a failed pass doesn't stop the loop
# (run.mjs already counts failures and alerts after 3 in a row).
while true; do
  node src/run.mjs "$@" || true
  sleep "${RUN_INTERVAL:-1200}"
done
