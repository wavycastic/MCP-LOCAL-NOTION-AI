#!/usr/bin/env bash
set -euo pipefail
# Quick tunnel de test. Production nen dung named tunnel + Cloudflare Access.
cloudflared tunnel --url http://127.0.0.1:"${PORT:-8765}"
