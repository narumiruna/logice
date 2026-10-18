#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

timeout --kill-after=5s 300 npm --prefix web run ci
timeout --kill-after=5s 300 sh scripts/check-go.sh
