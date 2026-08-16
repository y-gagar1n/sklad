#!/usr/bin/env bash
# Прогон тестов чистой логики склада (node:test, без зависимостей).
set -euo pipefail
cd "$(dirname "$0")"
node --test "tests/**/*.test.mjs"
