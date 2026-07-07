#!/bin/bash
# Start the e2e harness in the background
node ../e2e-harness/dist/main.js &
HARNESS_PID=$!

# Wait for the harness to be ready (max 15 seconds)
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:4174/v1/health > /dev/null 2>&1; then
    echo "[e2e] Harness is ready"
    break
  fi
  sleep 0.5
done

# Start vite preview (foreground, Playwright keeps this alive)
exec npx vite preview --port 4173
