#!/bin/bash

set -euo pipefail

bundle="${1:?Usage: verify-apple-bundle-linkage.sh <app-or-extension-bundle>}"
file_bin="${FILE_BIN:-/usr/bin/file}"
otool_bin="${OTOOL_BIN:-/usr/bin/otool}"

if [ ! -d "$bundle" ]; then
  echo "::error::Apple bundle does not exist: $bundle" >&2
  exit 1
fi

macho_list="$(mktemp)"
trap 'rm -f "$macho_list"' EXIT

while IFS= read -r -d '' candidate; do
  if "$file_bin" -b "$candidate" | grep -q 'Mach-O'; then
    printf '%s\n' "$candidate" >> "$macho_list"
  fi
done < <(find "$bundle" -type f -print0)

if [ ! -s "$macho_list" ]; then
  echo "::error::No Mach-O binaries found in $bundle." >&2
  exit 1
fi

owning_bundle() {
  local binary="$1"
  local directory
  directory="$(dirname "$binary")"
  while [[ "$directory" == "$bundle"* ]]; do
    case "$directory" in
      *.appex | *.app)
        printf '%s\n' "$directory"
        return
        ;;
    esac
    directory="$(dirname "$directory")"
  done
  printf '%s\n' "$bundle"
}

failures=0
checked=0
while IFS= read -r binary; do
  checked=$((checked + 1))
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    resolved=""
    case "$dependency" in
      /System/Library/* | /usr/lib/*)
        continue
        ;;
      @rpath/libswift*.dylib)
        continue
        ;;
      @rpath/*)
        suffix="${dependency#@rpath/}"
        resolved="$(find "$bundle" -type f -path "*/$suffix" -print -quit)"
        ;;
      @loader_path/*)
        candidate="$(dirname "$binary")/${dependency#@loader_path/}"
        [ -f "$candidate" ] && resolved="$candidate"
        ;;
      @executable_path/*)
        owner="$(owning_bundle "$binary")"
        candidate="$owner/${dependency#@executable_path/}"
        [ -f "$candidate" ] && resolved="$candidate"
        ;;
      *)
        if [ -f "$dependency" ]; then
          resolved="$dependency"
        fi
        ;;
    esac

    if [ -z "$resolved" ]; then
      echo "::error::Missing dynamic dependency $dependency required by ${binary#"$bundle"/}." >&2
      failures=$((failures + 1))
    fi
  done < <("$otool_bin" -L "$binary" | awk 'NR > 1 { print $1 }')
done < "$macho_list"

if [ "$failures" -ne 0 ]; then
  echo "::error::Apple bundle has $failures unresolved dynamic dependencies." >&2
  exit 1
fi

echo "Validated dynamic dependency closure for $checked Mach-O binaries."
