#!/bin/sh
# Runs one pass every $RUN_INTERVAL seconds (default 1200). A failed pass doesn't stop the loop
# (run.mjs counts failures and alerts after 3 in a row).
while true; do
  node src/run.mjs "$@"
  sleep "${RUN_INTERVAL:-1200}"
done
