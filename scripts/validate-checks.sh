#!/bin/sh
# Exercise real hook/CI commands in a disposable committed checkout.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d /tmp/logice-checks.XXXXXX)
trap 'rm -rf -- "$work"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
run() { timeout --kill-after=5s 300 "$@"; }
run git clone --quiet --no-hardlinks -- "$repo" "$work/repo"
cd "$work/repo"

for path in package.json package-lock.json biome.json tsconfig.json vitest.config.mts src/hello.ts src/index.ts tests/index.test.ts .changeset web/.changeset .github/workflows/publish.yml; do
  test ! -e "$path" || { printf 'Unexpected template path: %s\n' "$path" >&2; exit 1; }
done
test ! -e node_modules
test ! -e web/dist

# Restrict PATH to required Go/shell tools: Node.js cannot be discovered here.
mkdir "$work/go-bin"
for tool in go gofmt sh dirname find timeout mktemp rm git; do
  ln -s "$(command -v "$tool")" "$work/go-bin/$tool"
done
if PATH="$work/go-bin" command -v node; then
  printf '%s\n' 'Node.js unexpectedly available in Go-only PATH.' >&2
  exit 1
fi
(CGO_ENABLED=0 PATH="$work/go-bin" run sh scripts/check-go.sh)
test ! -e web/dist

HUSKY= run npm --prefix web ci
test "$(git config --get core.hooksPath)" = .husky/_
run node -e '
const p = require("./web/package.json");
const c = require("./.changenote/config.json").packages.logice;
const version = require("node:fs").readFileSync("VERSION", "utf8").trim();
const lock = require("./web/package-lock.json");
if (p.private !== true || p.name !== "logice-web" || p.scripts.release || p.scripts.publish ||
    p.scripts.changeset || p.devDependencies["@changesets/cli"] ||
    p.scripts["release:tag"] || p.scripts["release:github"] ||
    c.path !== "." || c.version_file !== "VERSION" || c.tag_prefix !== "v" ||
    JSON.stringify(c.version_outputs) !== JSON.stringify(["web/package.json"]) ||
    version !== p.version || lock.version !== version || lock.packages[""].version !== version) process.exit(1);
'

snapshot() {
  git diff --binary > "$work/$1.worktree"
  git diff --cached --binary > "$work/$1.index"
  git status --porcelain > "$work/$1.status"
  git ls-files --cached --others --exclude-standard -z | xargs -0 sha256sum > "$work/$1.files"
}
unchanged() {
  snapshot after
  for kind in worktree index status files; do
    cmp "$work/before.$kind" "$work/after.$kind"
  done
}

# The real script must locate the root even when invoked outside the checkout.
snapshot before
(cd "$work" && run sh "$work/repo/scripts/pre-commit.sh")
unchanged

expect_failure() {
  label=$1
  marker=$2
  shift 2
  snapshot before
  status=0
  run "$@" > "$work/failure.log" 2>&1 || status=$?
  if [ "$status" -eq 0 ] || [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf 'FAIL: %s returned %s, expected a check failure.\n' "$label" "$status" >&2
    exit 1
  fi
  if ! grep -F "$marker" "$work/failure.log" >/dev/null; then
    printf 'FAIL: %s did not detect the injected failure.\n' "$label" >&2
    tail -40 "$work/failure.log" >&2
    exit 1
  fi
  unchanged
  printf 'PASS: %s rejected the injected failure without source/index changes.\n' "$label"
}

printf 'package httpapi\nfunc checkNegative( ) {}\n' > internal/httpapi/check_negative_test.go
expect_failure 'Go formatting / hook' check_negative_test.go sh scripts/pre-commit.sh
expect_failure 'Go formatting / CI' check_negative_test.go sh scripts/check-go.sh
rm internal/httpapi/check_negative_test.go

printf 'package httpapi\n\nimport "testing"\n\nfunc TestCheckNegative(t *testing.T) {\n\tt.Fatal("go-check-negative-sentinel")\n}\n' > internal/httpapi/check_negative_test.go
expect_failure 'Go unit test / hook' go-check-negative-sentinel sh scripts/pre-commit.sh
expect_failure 'Go unit test / CI' go-check-negative-sentinel sh scripts/check-go.sh
rm internal/httpapi/check_negative_test.go

printf 'export const checkNegative= 1;\n' > web/src/check-negative.ts
expect_failure 'Web formatting / hook' check-negative.ts sh scripts/pre-commit.sh
expect_failure 'Web formatting / CI' check-negative.ts npm --prefix web run ci
rm web/src/check-negative.ts

printf 'import { test } from "vitest"\n\ntest("web-check-negative-sentinel", () => {\n  throw new Error("web-check-negative-sentinel")\n})\n' > web/src/check-negative.test.ts
expect_failure 'Web unit test / hook' web-check-negative-sentinel sh scripts/pre-commit.sh
expect_failure 'Web unit test / CI' web-check-negative-sentinel npm --prefix web run ci
rm web/src/check-negative.test.ts

test -z "$(git status --porcelain)"
printf '%s\n' 'PASS: clean checkout, no-Node Go checks, hook setup, and eight negative checks.'
