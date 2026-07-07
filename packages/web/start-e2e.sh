#!/bin/bash
set -x

# Start the e2e harness in the background
node ../e2e-harness/dist/main.js &
HARNESS_PID=$!
echo "[e2e] Harness started with PID $HARNESS_PID"

# Wait for the harness to be ready (max 15 seconds)
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:4174/v1/health > /dev/null 2>&1; then
    echo "[e2e] Harness is ready"
    break
  fi
  # Check if harness process is still alive
  if ! kill -0 $HARNESS_PID 2>/dev/null; then
    echo "[e2e] ERROR: Harness process died"
    exit 1
  fi
  sleep 0.5
done

# Verify harness is up
if ! curl -s http://127.0.0.1:4174/v1/health; then
  echo "[e2e] ERROR: Harness health check failed"
  exit 1
fi

# Check that web dist exists
if [ ! -d "dist" ]; then
  echo "[e2e] ERROR: dist/ directory not found, building..."
  npx vite build
fi

echo "[e2e] Starting vite preview..."
# Start vite preview (foreground, Playwright keeps this alive)
exec npx vite preview --port 4173 --host 127.0.0.1
