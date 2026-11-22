#!/usr/bin/env bash
set -euo pipefail

observe_memory() {
  echo 'macOS build memory snapshot'
  sysctl -n hw.memsize || true
  sysctl vm.swapusage || true
  vm_stat || true
}

finish_observation() {
  local build_status=$?
  observe_memory
  exit "$build_status"
}

observe_memory
trap finish_observation EXIT
/usr/bin/time -l "$@"
