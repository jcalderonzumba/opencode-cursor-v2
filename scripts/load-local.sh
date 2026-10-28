#!/usr/bin/env bash
# Rebuild the plugin from main and check the running host sees the cursor integration.
set -euo pipefail

branch="$(git symbolic-ref -q --short HEAD || true)"
if [ "$branch" != main ]; then
  echo "load-local: HEAD is ${branch:-detached}, not main" >&2
  exit 2
fi

npm run build

# shortcut: the call has no bound because macOS has no timeout, bound it if the host ever hangs
resp="$(opencode api get /api/integration 2>/dev/null)" || resp=""
case $resp in
  *'"id":"cursor"'*) echo "ok: cursor integration loaded" ;;
  *)
    echo "load-local: cursor integration not found" >&2
    exit 1
    ;;
esac

echo "Restart OpenCode to load the rebuilt plugin."
