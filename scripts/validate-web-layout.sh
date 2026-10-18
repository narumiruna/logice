#!/bin/sh
# Temporary stack validation; does not create or run a production frontend.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(node -p 'process.versions.node.split(".")[0]')" = 26 ] || {
  echo 'Node 26 is required.' >&2
  exit 1
}
command -v timeout >/dev/null
work=$(mktemp -d /tmp/logice-web-layout.XXXXXX)
child=
cleanup() {
  trap - 0 HUP INT TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
  rm -rf -- "$work"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
run() {
  timeout --kill-after=5s 300 "$@" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  return "$status"
}
cp -R "$repo/tests/fixtures/web-layout/web" "$work/web"
export npm_config_cache="$work/cache/npm"
export NODE_COMPILE_CACHE="$work/cache/node"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH="$work/cache/browsers"
export CI=1
cd "$work/web"
printf 'Temporary project: %s\nNode: %s; npm: %s\n' "$work" "$(node --version)" "$(npm --version)"
run npm ci --ignore-scripts --no-audit --no-fund
run npm audit --audit-level=low
run npm ls --depth=0
run npm run typecheck
run npm run test:unit
run npm run build
run npm run test:e2e:list
[ ! -e "$work/node_modules" ]
[ ! -e "$work/package.json" ]
[ ! -e "$PLAYWRIGHT_BROWSERS_PATH" ]
printf '%s\n' 'PASS: dependencies owned by web/; no root node_modules, root manifest, or browser download.'
