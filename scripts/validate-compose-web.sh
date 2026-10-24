#!/bin/sh
# Disposable container and browser checks. Requires Compose 2.24.4+ and web-local Playwright.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
project="logice-web-check-$(openssl rand -hex 8)"
replacement="$project-api-replacement"

# Do not read operator credentials or inherited Compose selection settings.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
export COMPOSE_DISABLE_ENV_FILE=1
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export CLICKHOUSE_PASSWORD="$(openssl rand -hex 32)"
export OTLP_TOKEN="$(openssl rand -hex 32)"
export ENCRYPTION_KEY="$(openssl rand -hex 32)"

compose() {
  timeout --kill-after=5s 180 docker compose --project-directory "$root" --project-name "$project" \
    --file "$root/compose.yaml" --file "$work/ports.yaml" "$@"
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "$status" -ne 0 ]; then
    timeout --kill-after=2s 5 docker compose --project-directory "$root" --project-name "$project" \
      --file "$root/compose.yaml" --file "$work/ports.yaml" logs --no-color --tail 40 api web migrate postgres >&2 || true
  fi
  timeout --kill-after=2s 5 docker rm --force "$replacement" >/dev/null 2>&1 || true
  if ! timeout --kill-after=2s 30 docker compose --project-directory "$root" --project-name "$project" \
    --file "$root/compose.yaml" --file "$work/ports.yaml" down --timeout 5 --volumes --remove-orphans --rmi local; then
    status=1
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Select a free loopback port before API startup so the exact trusted origin is
# known. Docker must still bind it; a concurrent claimant makes startup fail.
port=$(uv run python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export AUTH_ORIGIN="http://localhost:$port"
printf 'services:\n  web:\n    ports: !override\n      - "127.0.0.1:%s:8080"\n' "$port" > "$work/ports.yaml"
compose config --quiet
compose build api web
compose up --detach --wait --wait-timeout 90 api web clickhouse collector
address=$(compose port web 8080)
case "$address" in
  127.0.0.1:*) ;;
  *) printf 'Web port is not restricted to loopback: %s\n' "$address" >&2; exit 1 ;;
esac
api=$(compose ps --quiet api)
test "$(timeout --kill-after=5s 20 docker inspect --format '{{json .HostConfig.PortBindings}}' "$api")" = '{}'
test "$(compose exec -T api id -u)" = 65532
collector=$(compose ps --quiet collector)
test "$(timeout --kill-after=5s 20 docker inspect --format '{{json .HostConfig.PortBindings}}' "$collector")" = '{}'
base="$AUTH_ORIGIN"
curl --fail --silent --show-error --max-time 10 "$base/" > "$work/index.html"
grep -q '<div id="root"></div>' "$work/index.html"
asset=$(grep -oE 'src="/assets/[^" ]+\.js"' "$work/index.html" | head -n 1 | cut -d '"' -f 2)
test -n "$asset"
curl --fail --silent --show-error --max-time 10 "$base$asset" > "$work/app.js"
grep -q 'Logice' "$work/app.js"
curl --fail --silent --show-error --max-time 10 "$base/api/healthz" > "$work/health.json"
grep -qx '{"status":"ok"}' "$work/health.json"
for path in /api /api/not-found; do
  code=$(curl --silent --show-error --max-time 10 -D "$work/headers" -o "$work/error.json" -w '%{http_code}' "$base$path")
  test "$code" = 401
  grep -qi '^Content-Type: application/json' "$work/headers"
  grep -q '"code":"unauthorized"' "$work/error.json"
done
for path in /v1 /v1/not-found; do
  code=$(curl --silent --show-error --max-time 10 -D "$work/headers" -o "$work/error.json" -w '%{http_code}' "$base$path")
  test "$code" = 404
  grep -qi '^Content-Type: application/json' "$work/headers"
done
curl --fail --silent --show-error --max-time 10 "$base/traces/example" > "$work/route.html"
cmp "$work/index.html" "$work/route.html"
code=$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$base/assets/missing.js")
test "$code" = 404
# Run browser workflows against this project's real Collector and query API.
export LOGICE_E2E_URL="$base"
export LOGICE_E2E_OTLP_URL="$base"
export LOGICE_E2E_PROJECT="$project"
# Keep the invitation in subprocess environment only, never command arguments or logs.
LOGICE_E2E_INVITATION=$(compose exec -T api /app/logice bootstrap -name 'Browser administrator' | uv run python -c 'import json,sys; print(json.load(sys.stdin)["token"])')
export LOGICE_E2E_INVITATION
export LOGICE_E2E_AUTH_FILE="$work/browser-auth.json"
export LOGICE_E2E_OUTPUT_DIR="$work/browser-results"
timeout --kill-after=5s 180 npm --prefix "$root/web" run test:e2e -- --max-failures=1
# Allocate the replacement while the old API still owns its address. This
# guarantees a different dynamic IP without a fixed subnet or a static --ip.
image=$(timeout --kill-after=5s 20 docker inspect --format '{{.Config.Image}}' "$api")
old_ip=$(timeout --kill-after=5s 20 docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$api")
timeout --kill-after=5s 20 docker run --detach --name "$replacement" \
  --network "${project}_default" --network-alias api \
  --env CLICKHOUSE_ADDR=clickhouse:9000 --env CLICKHOUSE_PASSWORD \
  --env COLLECTOR_URL=http://collector:4318 --env OTLP_TOKEN \
  --env PGHOST=postgres --env PGPORT=5432 --env PGUSER=logice --env PGDATABASE=logice \
  --env PGPASSWORD="$POSTGRES_PASSWORD" --env AUTH_ORIGIN --env ENCRYPTION_KEY \
  "$image" -listen 0.0.0.0:8080 > /dev/null
new_ip=$(timeout --kill-after=5s 20 docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$replacement")
test -n "$old_ip"
test -n "$new_ip"
test "$new_ip" != "$old_ip"
# After removal, only the replacement remains at the api DNS alias.
compose rm --stop --force api
curl --fail --silent --show-error --max-time 5 --retry 10 --retry-delay 1 \
  --retry-max-time 30 --retry-all-errors "$base/api/healthz" > "$work/replaced-health.json"
grep -qx '{"status":"ok"}' "$work/replaced-health.json"
# Replacement keeps the database-backed authentication boundary and session.
code=$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$base/api/traces")
test "$code" = 401
uv run python - <<'PY'
import json
import os
import urllib.request
with open(os.environ["LOGICE_E2E_AUTH_FILE"]) as source:
    saved = json.load(source)
    cookies = saved["state"]["cookies"]
    project_id = saved["project"]["id"]
request = urllib.request.Request(
    os.environ["LOGICE_E2E_URL"] + "/api/projects/" + project_id + "/traces?limit=1",
    headers={"Cookie": "; ".join(c["name"] + "=" + c["value"] for c in cookies)},
)
with urllib.request.urlopen(request, timeout=10) as response:
    assert response.status == 200
PY
printf 'Compose web/API checks passed for %s.\n' "$project"
