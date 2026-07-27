#!/usr/bin/env bash
set -euo pipefail
if [ -f config.yml ]; then
  cloudflared tunnel --config config.yml run
else
  cloudflared tunnel --url http://127.0.0.1:"${PORT:-8765}"
fi
