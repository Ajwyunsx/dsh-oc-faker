#!/usr/bin/env bash
# dsh-oc-faker build — 纯 JS 插件，无需编译，仅校验必要文件。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f lib/index.js ] || { echo "build failed: missing lib/index.js" >&2; exit 1; }
echo "dsh-oc-faker build ok (pure JS, no compile step)"
