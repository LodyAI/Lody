#!/bin/bash

set -euo pipefail

sdk="${1:?Usage: ensure-metal-toolchain.sh <sdk>}"

if xcrun --sdk "$sdk" metal --version; then
  exit 0
fi

echo "Metal toolchain is not mounted. Downloading."
xcodebuild -downloadComponent MetalToolchain

# Download returns when the DMG is on disk. cryptexd mounts it afterwards,
# and xcrun fails immediately until that mount exists.
for _ in $(seq 1 30); do
  if version="$(xcrun --sdk "$sdk" metal --version 2>/dev/null)"; then
    printf '%s\n' "$version"
    exit 0
  fi
  sleep 1
done

dmg="$(find /System/Library/AssetsV2/com_apple_MobileAsset_MetalToolchain -name '*.dmg' -print -quit 2>/dev/null || true)"
if [ -z "$dmg" ]; then
  echo "::error::Metal toolchain download finished without a DMG." >&2
  exit 1
fi

echo "cryptexd did not mount the toolchain. Attaching $dmg"
if ! hdiutil attach "$dmg" -nobrowse; then
  echo "hdiutil attach failed." >&2
fi

if version="$(xcrun --sdk "$sdk" metal --version 2>/dev/null)"; then
  printf '%s\n' "$version"
  exit 0
fi

echo "::error::Metal compiler is still unavailable for sdk $sdk." >&2
xcrun --sdk "$sdk" metal --version || true
xcodebuild -showComponent metalToolchain || true
exit 1
